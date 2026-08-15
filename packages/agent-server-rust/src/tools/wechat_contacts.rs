use super::wechat_db::{get_db_path, query_wechat_db};
use crate::ia::types::Contact;
use std::collections::HashMap;

/// Known system/internal usernames to exclude from contact listings.
const SYSTEM_USERNAMES: &[&str] = &[
    "qmessage",
    "floatbottle",
    "medianote",
    "notifymessage",
    "weixin",
    "fmessage",
    "filehelper",
    "newsapp",
    "tmessage",
    "mphelper",
    "qqmail",
    "weixingongzhong",
    "qqsafe",
    "exmail_tool",
    "lbsapp",
    "pc_qq",
];

fn classify_contact(username: &str, local_type: i64) -> &'static str {
    if username.ends_with("@chatroom") {
        "chatroom"
    } else if username.starts_with("gh_") {
        "official"
    } else if username.contains("@openim") || local_type == 5 {
        "openim"
    } else {
        "individual"
    }
}

fn is_system_account(username: &str) -> bool {
    SYSTEM_USERNAMES.contains(&username)
}

/// Every username whose nick_name or remark equals `display_name`.
/// Unbounded: this is the uniqueness check for a11y identity, so a 200-row
/// session window is not sufficient.
pub fn usernames_for_display_name(
    account_dir: &str,
    keys: &HashMap<String, String>,
    display_name: &str,
) -> Vec<String> {
    let contact_key = match keys.get("contact.db") {
        Some(k) => k,
        None => return Vec::new(),
    };
    if display_name.is_empty() {
        return Vec::new();
    }
    let contact_db = get_db_path(account_dir, "contact.db");
    let escaped = display_name.replace('\'', "''");
    let rows = query_wechat_db(
        &contact_db,
        contact_key,
        &format!(
            "SELECT username FROM contact
             WHERE nick_name = '{escaped}' OR remark = '{escaped}'"
        ),
    );
    rows.iter()
        .filter_map(|row| {
            let username = row.get("username")?.as_str()?;
            if is_system_account(username) {
                return None;
            }
            Some(username.to_string())
        })
        .collect()
}

/// List contacts from contact.db.
/// Queries the contact table directly (not session.db), returning all stored contacts.
pub fn list_contacts(
    account_dir: &str,
    keys: &HashMap<String, String>,
    limit: i64,
    cursor: Option<&str>,
) -> Vec<Contact> {
    let contact_key = match keys.get("contact.db") {
        Some(k) => k,
        None => return Vec::new(),
    };

    let contact_db = get_db_path(account_dir, "contact.db");

    let cursor_clause = match cursor {
        Some(raw) => {
            let Ok((remark_missing, label, username)) = crate::tools::page_cursor::decode::<(bool, String, String)>("contacts", raw) else {
                return Vec::new();
            };
            let remark_rank = if remark_missing { 0 } else { 1 };
            let escaped_label = label.replace('\'', "''");
            let escaped_username = username.replace('\'', "''");
            format!(" AND ((remark != '') < {remark_rank} OR ((remark != '') = {remark_rank} AND (lower(CASE WHEN remark != '' THEN remark ELSE nick_name END) > '{escaped_label}' OR (lower(CASE WHEN remark != '' THEN remark ELSE nick_name END) = '{escaped_label}' AND username > '{escaped_username}'))))")
        }
        None => String::new(),
    };
    let safe_limit = limit.clamp(1, 200);
    // local_type: 0=system notifications, 1=contacts+official, 2=chatrooms, 3=contacts, 5=openim
    let rows = query_wechat_db(
        &contact_db,
        contact_key,
        &format!(
            "SELECT username, nick_name, remark, alias, small_head_url, local_type
             FROM contact
             WHERE local_type IN (1, 3, 5)
               AND username NOT LIKE '%@chatroom'{cursor_clause}
             ORDER BY remark != '' DESC, lower(CASE WHEN remark != '' THEN remark ELSE nick_name END) ASC, username ASC
             LIMIT {safe_limit};"
        ),
    );

    rows.iter()
        .filter_map(|row| {
            let username = row.get("username")?.as_str()?;
            if is_system_account(username) {
                return None;
            }

            let local_type = row
                .get("local_type")
                .and_then(|v| v.as_i64())
                .unwrap_or(3);

            Some(Contact {
                username: username.to_string(),
                nick_name: row
                    .get("nick_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                remark: row
                    .get("remark")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                alias: row
                    .get("alias")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                small_head_url: row
                    .get("small_head_url")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                contact_type: classify_contact(username, local_type).to_string(),
            })
        })
        .collect()
}

/// Search contacts by name (partial match on nick_name, remark, alias, or username).
pub fn find_contacts(
    account_dir: &str,
    keys: &HashMap<String, String>,
    query: &str,
) -> Vec<Contact> {
    let contact_key = match keys.get("contact.db") {
        Some(k) => k,
        None => return Vec::new(),
    };

    let contact_db = get_db_path(account_dir, "contact.db");
    let escaped = query.replace('\'', "''");

    let rows = query_wechat_db(
        &contact_db,
        contact_key,
        &format!(
            "SELECT username, nick_name, remark, alias, small_head_url, local_type
             FROM contact
             WHERE local_type IN (1, 3, 5)
               AND username NOT LIKE '%@chatroom'
               AND (nick_name LIKE '%{escaped}%'
                    OR remark LIKE '%{escaped}%'
                    OR alias LIKE '%{escaped}%'
                    OR username LIKE '%{escaped}%')
             ORDER BY remark != '' DESC, nick_name COLLATE NOCASE ASC
             LIMIT 50;"
        ),
    );

    rows.iter()
        .filter_map(|row| {
            let username = row.get("username")?.as_str()?;
            if is_system_account(username) {
                return None;
            }

            let local_type = row
                .get("local_type")
                .and_then(|v| v.as_i64())
                .unwrap_or(3);

            Some(Contact {
                username: username.to_string(),
                nick_name: row
                    .get("nick_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                remark: row
                    .get("remark")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                alias: row
                    .get("alias")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                small_head_url: row
                    .get("small_head_url")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                contact_type: classify_contact(username, local_type).to_string(),
            })
        })
        .collect()
}
