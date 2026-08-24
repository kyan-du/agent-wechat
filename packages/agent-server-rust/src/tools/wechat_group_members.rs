use super::wechat_db::{get_db_path, query_wechat_db_checked};
use crate::ia::types::GroupMember;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupMemberQueryError {
    NotGroup,
    GroupNotFound,
    NotMember,
    InvalidCursor,
    MissingDatabase,
}

impl GroupMemberQueryError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotGroup => "NOT_GROUP_CHAT",
            Self::GroupNotFound => "GROUP_NOT_FOUND",
            Self::NotMember => "GROUP_NOT_JOINED",
            Self::InvalidCursor => "INVALID_CURSOR",
            Self::MissingDatabase => "GROUP_MEMBERS_UNAVAILABLE",
        }
    }
}

fn read_varint(bytes: &[u8], offset: &mut usize) -> Option<u64> {
    let mut value = 0_u64;
    for shift in (0_usize..70).step_by(7) {
        let byte = *bytes.get(*offset)?;
        *offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

fn group_aliases_from_ext_buffer(hex: &str) -> HashMap<String, String> {
    if hex.len() % 2 != 0 || !hex.is_ascii() {
        return HashMap::new();
    }
    let Ok(bytes) = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
        .collect::<Result<Vec<_>, _>>()
    else {
        return HashMap::new();
    };
    let mut aliases = HashMap::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let Some(key) = read_varint(&bytes, &mut offset) else {
            break;
        };
        if key & 7 != 2 {
            if key & 7 == 0 {
                let _ = read_varint(&bytes, &mut offset);
            } else {
                break;
            }
            continue;
        }
        let Some(length) = read_varint(&bytes, &mut offset).map(|v| v as usize) else {
            break;
        };
        let Some(payload) = bytes.get(offset..offset + length) else {
            break;
        };
        offset += length;
        let mut nested = 0;
        let mut wxid = None;
        let mut display = None;
        while nested < payload.len() {
            let Some(nested_key) = read_varint(payload, &mut nested) else {
                break;
            };
            if nested_key & 7 != 2 {
                if nested_key & 7 == 0 {
                    let _ = read_varint(payload, &mut nested);
                } else {
                    break;
                }
                continue;
            }
            let Some(nested_len) = read_varint(payload, &mut nested).map(|v| v as usize) else {
                break;
            };
            let Some(value) = payload.get(nested..nested + nested_len) else {
                break;
            };
            nested += nested_len;
            if nested_key >> 3 == 1 {
                wxid = std::str::from_utf8(value).ok().map(str::to_string);
            }
            if nested_key >> 3 == 2 {
                display = std::str::from_utf8(value).ok().map(str::to_string);
            }
        }
        if let (Some(wxid), Some(display)) = (wxid, display) {
            if !wxid.is_empty() && !display.is_empty() {
                aliases.insert(wxid, display);
            }
        }
    }
    aliases
}

/// List group members directly from contact.db. The query is read-only and
/// keyset-paginated by stable member id; it never logs member fields.
pub fn list_group_members(
    account_dir: &str,
    keys: &HashMap<String, String>,
    group_id: &str,
    limit: i64,
    cursor: Option<&str>,
) -> Result<Vec<GroupMember>, GroupMemberQueryError> {
    if !group_id.ends_with("@chatroom") {
        return Err(GroupMemberQueryError::NotGroup);
    }
    let contact_key = keys
        .get("contact.db")
        .ok_or(GroupMemberQueryError::MissingDatabase)?;
    let contact_db = get_db_path(account_dir, "contact.db");
    let escaped_group = group_id.replace('\'', "''");
    let group = query_wechat_db_checked(
        &contact_db,
        contact_key,
        &format!(
            "SELECT r.id, r.username, c.id AS contact_id, c.delete_flag
             FROM chat_room r
             LEFT JOIN contact c ON c.username = r.username
             WHERE r.username = '{escaped_group}'
             LIMIT 1;"
        ),
    )
    .map_err(|_| GroupMemberQueryError::MissingDatabase)?;
    let Some(group) = group.first() else {
        return Err(GroupMemberQueryError::GroupNotFound);
    };
    if group
        .get("contact_id")
        .and_then(|value| value.as_i64())
        .is_none()
        || group
            .get("delete_flag")
            .and_then(|value| value.as_i64())
            .unwrap_or(1)
            != 0
    {
        return Err(GroupMemberQueryError::NotMember);
    }
    let room_id = group
        .get("id")
        .and_then(|value| value.as_i64())
        .ok_or(GroupMemberQueryError::GroupNotFound)?;

    let cursor_clause = match cursor {
        Some(raw) => {
            let (cursor_group, member_id) =
                crate::tools::page_cursor::decode::<(String, String)>("group_members", raw)
                    .map_err(|_| GroupMemberQueryError::InvalidCursor)?;
            if cursor_group != group_id {
                return Err(GroupMemberQueryError::InvalidCursor);
            }
            format!(" AND c.username > '{}'", member_id.replace('\'', "''"))
        }
        None => String::new(),
    };
    let safe_limit = crate::tools::page_cursor::lookahead_query_limit(limit, 100);
    let rows = query_wechat_db_checked(
        &contact_db,
        contact_key,
        &format!(
            "SELECT c.id, c.username, c.nick_name, hex(r.ext_buffer) AS room_ext
             FROM chatroom_member m
             JOIN contact c ON c.id = m.member_id
             JOIN chat_room r ON r.id = m.room_id
             WHERE m.room_id = {room_id}
               AND c.username != ''
               AND c.username NOT LIKE '%@chatroom'{cursor_clause}
             ORDER BY c.username ASC
             LIMIT {safe_limit};"
        ),
    )
    .map_err(|_| GroupMemberQueryError::MissingDatabase)?;

    let room_aliases = rows
        .iter()
        .find_map(|row| {
            row.get("room_ext")
                .and_then(|value| value.as_str())
                .map(group_aliases_from_ext_buffer)
        })
        .unwrap_or_default();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let member_id = row.get("username")?.as_str()?.trim();
            if member_id.is_empty() || member_id.ends_with("@chatroom") {
                return None;
            }
            let group_alias = room_aliases.get(member_id).cloned();
            let nick_name = row
                .get("nick_name")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let display_name = group_alias
                .as_ref()
                .or(nick_name.as_ref())
                .cloned()
                .unwrap_or_else(|| member_id.to_string());
            Some(GroupMember {
                member_id: member_id.to_string(),
                display_name,
                group_alias,
                nick_name,
                sort_id: row.get("id").and_then(|value| value.as_i64()).unwrap_or(0),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_chats_before_db_access() {
        assert_eq!(
            list_group_members("account", &HashMap::new(), "wxid_friend", 10, None),
            Err(GroupMemberQueryError::NotGroup)
        );
    }

    fn length_delimited(field: u8, value: &[u8]) -> Vec<u8> {
        let mut encoded = vec![field << 3 | 2, value.len() as u8];
        encoded.extend_from_slice(value);
        encoded
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn aliases_preserve_unicode_and_ignore_empty_values() {
        let mut unicode_member = length_delimited(1, b"wxid_a");
        unicode_member.extend(length_delimited(2, "群昵称😀".as_bytes()));
        let mut empty_member = length_delimited(1, b"wxid_b");
        empty_member.extend(length_delimited(2, b""));
        let mut outer = length_delimited(1, &unicode_member);
        outer.extend(length_delimited(1, &empty_member));

        let aliases = group_aliases_from_ext_buffer(&hex(&outer));
        assert_eq!(aliases.get("wxid_a").map(String::as_str), Some("群昵称😀"));
        assert!(!aliases.contains_key("wxid_b"));
    }

    #[test]
    fn malformed_or_truncated_alias_buffers_fail_closed() {
        assert!(group_aliases_from_ext_buffer("not-hex").is_empty());
        assert!(group_aliases_from_ext_buffer("0a10ff").is_empty());
    }
}
