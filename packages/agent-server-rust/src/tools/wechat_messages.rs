use super::wechat_db::{get_db_path, query_wechat_db};
use crate::ia::types::{ForwardedMessageNode, ForwardedMessageTree, Message, ReplyInfo};
use crate::tools::wechat_message_type::normalize_local_type;
use md5::{Digest, Md5};
use std::collections::HashMap;

/// ZSTD magic number (little-endian): 0xFD2FB528
const ZSTD_MAGIC: &str = "28b52ffd";

/// Get the Msg table name for a given chat username.
/// WeChat uses MD5(username) as the table suffix.
pub fn get_msg_table_name(chat_id: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(chat_id.as_bytes());
    let hash = hasher.finalize();
    format!("Msg_{:x}", hash)
}

/// Decode hex-encoded message content, decompressing zstd if needed.
pub fn decode_message_content(hex: &str, is_compressed: bool) -> String {
    if hex.is_empty() {
        return String::new();
    }
    let bytes = match hex_decode(hex) {
        Some(b) => b,
        None => return String::new(),
    };
    if is_compressed && hex.len() >= 8 && hex[..8].eq_ignore_ascii_case(ZSTD_MAGIC) {
        match zstd::decode_all(bytes.as_slice()) {
            Ok(decompressed) => String::from_utf8_lossy(&decompressed).to_string(),
            Err(_) => "[compressed content - decompression failed]".to_string(),
        }
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    }
}

/// Decode a hex string to bytes.
pub fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for i in (0..hex.len()).step_by(2) {
        let byte = u8::from_str_radix(&hex[i..i + 2], 16).ok()?;
        bytes.push(byte);
    }
    Some(bytes)
}

/// Extract sender from group message content.
/// Group messages have format "sender_wxid:\nmessage_content".
fn extract_group_sender(content: &str) -> (Option<String>, String) {
    if let Some(idx) = content.find(":\n") {
        if idx < 80 {
            let sender = content[..idx].to_string();
            let msg = content[idx + 2..].to_string();
            return (Some(sender), msg);
        }
    }
    (None, content.to_string())
}

/// Clean message content for display based on message type.
/// Replaces verbose XML with concise summaries.
const FORWARD_MAX_DEPTH: usize = 8;
const FORWARD_MAX_NODES: usize = 500;
const FORWARD_MAX_XML_BYTES: usize = 512 * 1024;

fn xml_unescape(value: &str) -> String {
    value.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn find_element_end(xml: &str, start: usize, tag: &str) -> Option<usize> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut depth = 0usize;
    let mut cursor = start;
    while cursor < xml.len() {
        let next_open = xml[cursor..].find(&open).map(|offset| cursor + offset);
        let next_close = xml[cursor..].find(&close).map(|offset| cursor + offset);
        match (next_open, next_close) {
            (Some(open_at), Some(close_at)) if open_at < close_at => {
                depth += 1;
                cursor = open_at + open.len();
            }
            (_, Some(close_at)) if depth > 0 => {
                depth -= 1;
                let end = close_at + close.len();
                if depth == 0 { return Some(end); }
                cursor = end;
            }
            _ => return None,
        }
    }
    None
}

fn parse_forward_nodes(xml: &str, depth: usize, budget: &mut usize) -> (Vec<ForwardedMessageNode>, bool) {
    if depth > FORWARD_MAX_DEPTH || xml.len() > FORWARD_MAX_XML_BYTES || *budget == 0 {
        return (Vec::new(), true);
    }
    let mut nodes = Vec::new();
    let mut truncated = false;
    let mut cursor = 0;
    while let Some(start) = xml[cursor..].find("<dataitem") {
        if *budget == 0 { truncated = true; break; }
        let start = cursor + start;
        let Some(end) = find_element_end(xml, start, "dataitem") else { truncated = true; break; };
        let item = &xml[start..end];
        let content = extract_xml_tag(item, "datadesc").or_else(|| extract_xml_tag(item, "datatitle"));
        let nested = extract_xml_tag(item, "recorditem").map(|nested| xml_unescape(&nested));
        let (children, child_truncated) = nested.map(|nested| parse_forward_nodes(&nested, depth + 1, budget)).unwrap_or_default();
        let message_type = extract_xml_tag(item, "type").and_then(|value| value.parse::<i32>().ok());
        let node = ForwardedMessageNode {
            sender: extract_xml_tag(item, "sourcename").or_else(|| extract_xml_tag(item, "displayname")),
            sender_id: extract_xml_tag(item, "fromusr"),
            timestamp: extract_xml_tag(item, "createtime").or_else(|| extract_xml_tag(item, "timestamp")),
            text: content,
            message_type,
            media: extract_xml_tag(item, "cdnthumburl").or_else(|| extract_xml_tag(item, "cdnurl")),
            children,
            truncated: child_truncated,
        };
        nodes.push(node);
        *budget -= 1;
        truncated |= child_truncated;
        cursor = end;
    }
    (nodes, truncated)
}

fn parse_forwarded_tree(content: &str) -> Option<ForwardedMessageTree> {
    let appmsg_type = extract_xml_tag(content, "type").and_then(|value| value.parse::<i32>().ok());
    if appmsg_type != Some(19) { return None; }
    let record = extract_xml_tag(content, "recorditem")?;
    if record.len() > FORWARD_MAX_XML_BYTES { return Some(ForwardedMessageTree { schema_version: 1, title: extract_xml_tag(content, "title"), nodes: Vec::new(), truncated: true }); }
    let mut budget = FORWARD_MAX_NODES;
    let (nodes, truncated) = parse_forward_nodes(&xml_unescape(&record), 0, &mut budget);
    Some(ForwardedMessageTree { schema_version: 1, title: extract_xml_tag(content, "title"), nodes, truncated })
}

fn clean_content(content: &str, local_type: i64) -> String {
    let base = normalize_local_type(local_type).base;
    match base {
        // Image (type 3): replace XML with empty string
        3 if content.contains("<img") => String::new(),
        // Emoji (type 47): show cdnurl or [emoji]
        47 if content.contains("<emoji") => {
            extract_xml_attr(content, "cdnurl")
                .filter(|u| u.starts_with("http"))
                .unwrap_or_else(|| "[emoji]".to_string())
        }
        // Appmsg (type 49): handle subtypes
        49 if content.contains("<msg>") => {
            let title = extract_xml_tag(content, "title").unwrap_or_default();
            let appmsg_type = extract_xml_tag(content, "type")
                .and_then(|t| t.parse::<i32>().ok())
                .unwrap_or(0);
            match appmsg_type {
                // Link share (5), video link (4), music share (3)
                3 | 4 | 5 => {
                    let mut parts = Vec::new();
                    parts.push(format!("[Link] {title}"));
                    if let Some(des) = extract_xml_tag(content, "des") {
                        parts.push(des);
                    }
                    if let Some(url) = extract_xml_tag(content, "url") {
                        let url = url.replace("&amp;", "&");
                        parts.push(url);
                    }
                    parts.join("\n")
                }
                // Merged forward / chat history (19)
                19 => {
                    let mut parts = Vec::new();
                    parts.push(format!("[Chat History] {title}"));
                    // recorditem is XML-escaped inside the appmsg
                    if let Some(record_raw) = extract_xml_tag(content, "recorditem") {
                        let record = record_raw
                            .replace("&lt;", "<")
                            .replace("&gt;", ">")
                            .replace("&amp;", "&")
                            .replace("&quot;", "\"");
                        // Extract each <dataitem> block
                        let mut search_from = 0usize;
                        while let Some(start) = record[search_from..].find("<dataitem") {
                            let abs_start = search_from + start;
                            if let Some(end_offset) = record[abs_start..].find("</dataitem>") {
                                let item = &record[abs_start..abs_start + end_offset + "</dataitem>".len()];
                                let sender_name = extract_xml_tag(item, "sourcename")
                                    .or_else(|| extract_xml_tag(item, "displayname"))
                                    .map(|value| value.replace("&amp;", "&"))
                                    .unwrap_or_default();
                                let data_title = extract_xml_tag(item, "datatitle")
                                    .or_else(|| extract_xml_tag(item, "datadesc"))
                                    .map(|value| value.replace("&amp;", "&"))
                                    .unwrap_or_else(|| "[media]".to_string());
                                if !sender_name.is_empty() {
                                    parts.push(format!("{sender_name}: {data_title}"));
                                } else {
                                    parts.push(data_title);
                                }
                                search_from = abs_start + end_offset + "</dataitem>".len();
                            } else {
                                break;
                            }
                        }
                    }
                    if parts.len() == 1 {
                        // Only title, no items parsed — fall back to title
                        title
                    } else {
                        parts.join("\n")
                    }
                }
                _ => {
                    if title.is_empty() {
                        content.to_string()
                    } else {
                        title
                    }
                }
            }
        }
        _ => content.to_string(),
    }
}

/// Extract reply info from type 49 (appmsg) messages with <refermsg>.
fn extract_reply_info(content: &str, msg_type: i32) -> Option<ReplyInfo> {
    let base = msg_type & 0x7FFFFFFF;
    if base != 49 || !content.contains("<refermsg>") {
        return None;
    }
    // Extract the refermsg block
    let rm_start = content.find("<refermsg>")?;
    let rm_end = content.find("</refermsg>")? + "</refermsg>".len();
    let refermsg = &content[rm_start..rm_end];

    let sender = extract_xml_tag(refermsg, "displayname");
    let ref_content = extract_xml_tag(refermsg, "content").unwrap_or_default();

    // The referred content may be XML-escaped — unescape first
    let unescaped = ref_content
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"");

    let media_error_code = if unescaped.contains("<img") {
        Some("QUOTED_IMAGE_RESOURCE_UNAVAILABLE".to_string())
    } else {
        None
    };

    // The referred content may itself be XML — clean it to a short text
    let clean = if unescaped.contains("<msg>") {
        extract_xml_tag(&unescaped, "title").unwrap_or(unescaped)
    } else {
        unescaped
    };
    Some(ReplyInfo {
        sender,
        content: clean,
        media_error_code,
    })
}

/// Extract an XML attribute value: attr="value"
fn extract_xml_attr(xml: &str, attr: &str) -> Option<String> {
    let pattern = format!("{attr}=\"");
    let start = xml.find(&pattern)? + pattern.len();
    let end = xml[start..].find('"')? + start;
    let val = xml[start..end].trim().to_string();
    if val.is_empty() { None } else { Some(val) }
}

/// Extract text between XML tags: <tag>text</tag>
/// Also handles CDATA: <tag><![CDATA[text]]></tag>
pub(crate) fn extract_xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    let mut val = xml[start..end].trim().to_string();
    // Strip CDATA wrapper if present
    if val.starts_with("<![CDATA[") && val.ends_with("]]>") {
        val = val[9..val.len() - 3].to_string();
    }
    if val.is_empty() { None } else { Some(val) }
}

/// Check if the source XML indicates the current user is @-mentioned.
fn check_is_mentioned(source: &str, account_dir: &str) -> bool {
    if let Some(at_list) = extract_xml_tag(source, "atuserlist") {
        // atuserlist may contain comma-separated wxids
        for wxid in at_list.split(',') {
            let wxid = wxid.trim();
            if !wxid.is_empty() && account_dir.starts_with(wxid) {
                return true;
            }
        }
    }
    false
}

/// Find which message DB contains a chat and return (db_name, key).
pub fn find_message_db<'a>(
    account_dir: &str,
    keys: &'a HashMap<String, String>,
    chat_id: &str,
) -> Option<(String, &'a str)> {
    let table_name = get_msg_table_name(chat_id);
    let mut message_dbs: Vec<(&str, &str)> = keys
        .iter()
        .filter(|(k, _)| {
            k.starts_with("message_")
                && k.ends_with(".db")
                && !k.contains("fts")
                && !k.contains("resource")
        })
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    message_dbs.sort_by_key(|(k, _)| k.to_string());

    for (db_name, key) in &message_dbs {
        let db_path = get_db_path(account_dir, db_name);
        let check = query_wechat_db(
            &db_path,
            key,
            &format!(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='{table_name}';"
            ),
        );
        if !check.is_empty() {
            return Some((db_name.to_string(), key));
        }
    }
    None
}

/// List messages for a specific chat.
///
/// Messages may be spread across message_0.db, message_1.db, etc.
/// Each chat's messages are in a `Msg_{MD5(username)}` table.
pub fn list_messages(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    limit: i64,
    cursor: Option<&str>,
) -> Vec<Message> {
    list_messages_in_range(account_dir, keys, chat_id, limit, cursor, None, None)
}

/// Read a stable message page with optional inclusive RFC3339 time bounds.
/// Bounds are applied in SQL before the lookahead query so a narrow range cannot
/// accidentally consume an entire page of out-of-range rows.
pub fn list_messages_in_range(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    limit: i64,
    cursor: Option<&str>,
    from_timestamp: Option<&str>,
    to_timestamp: Option<&str>,
) -> Vec<Message> {
    list_messages_window(account_dir, keys, chat_id, limit, cursor, from_timestamp, to_timestamp, None)
}

/// Read messages newer than an opaque sync watermark.
pub fn list_messages_since(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    limit: i64,
    since_timestamp: i64,
    since_local_id: i64,
) -> Vec<Message> {
    list_messages_window(account_dir, keys, chat_id, limit, None, None, None, Some((since_timestamp, since_local_id)))
}

fn list_messages_window(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    limit: i64,
    cursor: Option<&str>,
    from_timestamp: Option<&str>,
    to_timestamp: Option<&str>,
    since: Option<(i64, i64)>,
) -> Vec<Message> {
    let table_name = get_msg_table_name(chat_id);
    let is_group = chat_id.contains("@chatroom");

    let (db_name, key) = match find_message_db(account_dir, keys, chat_id) {
        Some(dk) => dk,
        None => return Vec::new(),
    };
    let db_path = get_db_path(account_dir, &db_name);

    let mut predicates = Vec::new();
    if let Some(raw) = cursor {
        let kind = format!("messages:{chat_id}");
        let Ok((timestamp, local_id)) = crate::tools::page_cursor::decode::<(String, i64)>(&kind, raw) else {
            return Vec::new();
        };
        let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&timestamp) else {
            return Vec::new();
        };
        let timestamp = parsed.timestamp();
        predicates.push(format!("(m.create_time < {timestamp} OR (m.create_time = {timestamp} AND m.local_id < {local_id}))"));
    }
    if let Some((timestamp, local_id)) = since {
        predicates.push(format!("(m.create_time > {timestamp} OR (m.create_time = {timestamp} AND m.local_id > {local_id}))"));
    }
    for (column, value, operator) in [
        ("m.create_time", from_timestamp, ">="),
        ("m.create_time", to_timestamp, "<="),
    ] {
        let Some(value) = value else { continue };
        let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(value) else { return Vec::new() };
        predicates.push(format!("{column} {operator} {}", parsed.timestamp()));
    }
    let where_clause = if predicates.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", predicates.join(" AND "))
    };
    let safe_limit = crate::tools::page_cursor::lookahead_query_limit(limit, 200);
    // Stable keyset pagination prevents inserts from shifting subsequent pages.
    let rows = query_wechat_db(
        &db_path,
        key,
        &format!(
            "SELECT m.local_id, m.server_id, m.local_type, m.create_time,
                    hex(m.message_content) as hex_content,
                    m.WCDB_CT_message_content as is_compressed,
                    hex(m.source) as hex_source,
                    m.WCDB_CT_source as source_compressed,
                    n.user_name as sender_name
             FROM \"{table_name}\" m
             LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid{where_clause}
             ORDER BY m.create_time DESC, m.local_id DESC
             LIMIT {safe_limit};"
        ),
    );

    // Resolve sender display names from contact.db
    let contact_names: HashMap<String, String> = {
        let mut map = HashMap::new();
        if let Some(contact_key) = keys.get("contact.db") {
            // Collect unique sender wxids
            let senders: Vec<String> = rows.iter()
                .filter_map(|row| {
                    row.get("sender_name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                })
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();

            if !senders.is_empty() {
                let contact_db = get_db_path(account_dir, "contact.db");
                let placeholders = senders.iter().map(|s| format!("'{}'", s.replace('\'', "''"))).collect::<Vec<_>>().join(",");
                let contacts = query_wechat_db(
                    &contact_db,
                    contact_key,
                    &format!("SELECT username, nick_name, remark FROM contact WHERE username IN ({placeholders});"),
                );
                for c in contacts {
                    if let Some(username) = c.get("username").and_then(|v| v.as_str()) {
                        let name = c.get("remark").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
                            .or_else(|| c.get("nick_name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
                            .unwrap_or(username);
                        map.insert(username.to_string(), name.to_string());
                    }
                }
            }
        }
        map
    };

    rows.iter()
        .filter_map(|row| {
            let local_id = row.get("local_id")?.as_i64()?;
            let server_id = row
                .get("server_id")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let local_type = row
                .get("local_type")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let msg_type = normalize_local_type(local_type).base;

            let hex_content = row
                .get("hex_content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let is_compressed = row
                .get("is_compressed")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                != 0;

            let raw_content = decode_message_content(hex_content, is_compressed);

            // Get sender from Name2Id join (works for both group and 1:1 chats)
            let sender = row
                .get("sender_name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());

            // Strip group sender prefix from content ("wxid:\ncontent" format)
            let body = if is_group {
                extract_group_sender(&raw_content).1
            } else {
                raw_content
            };

            // Extract structured forwarded history before cleaning its display summary.
            let forwarded = parse_forwarded_tree(&body);
            let reply = extract_reply_info(&body, msg_type);

            // Clean content for display (replace XML with summaries)
            let content = clean_content(&body, local_type);

            let timestamp = row
                .get("create_time")
                .and_then(|v| v.as_i64())
                .map(|t| {
                    chrono::DateTime::from_timestamp(t, 0)
                        .map(|dt| dt.to_rfc3339())
                        .unwrap_or_default()
                })
                .unwrap_or_default();

            // Check @-mention from source XML (only for group chats)
            let is_mentioned = if is_group {
                let hex_source = row
                    .get("hex_source")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let source_compressed = row
                    .get("source_compressed")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
                    != 0;
                let from_source = if !hex_source.is_empty() {
                    let source_xml = decode_message_content(hex_source, source_compressed);
                    check_is_mentioned(&source_xml, account_dir)
                } else {
                    false
                };

                // For type-49 (appmsg) messages — especially reference/quote messages —
                // WeChat may place <atuserlist> inside the content XML instead of source.
                let from_content = if !from_source && (msg_type & 0x7FFFFFFF) == 49 {
                    check_is_mentioned(&body, account_dir)
                } else {
                    false
                };

                if from_source || from_content {
                    Some(true)
                } else {
                    None
                }
            } else {
                None
            };

            // Check if message was sent by the logged-in user
            let is_self = sender.as_ref().map(|s| account_dir.starts_with(s.as_str()));

            let sender_name = sender.as_ref()
                .and_then(|wxid| contact_names.get(wxid))
                .cloned();

            Some(Message {
                local_id,
                server_id,
                chat_id: chat_id.to_string(),
                sender,
                sender_name,
                msg_type,
                content,
                timestamp,
                is_mentioned,
                is_self,
                reply,
                forwarded,
            })
        })
        .collect()
}

#[cfg(test)]
mod merged_forward_tests {
    use super::*;

    #[test]
    fn parses_escaped_merged_forward_items() {
        let xml = r#"<msg><appmsg><title>Team history</title><type>19</type><recorditem>&lt;recordinfo&gt;&lt;dataitem&gt;&lt;sourcename&gt;Alice&lt;/sourcename&gt;&lt;datatitle&gt;Hello &amp;amp; welcome&lt;/datatitle&gt;&lt;/dataitem&gt;&lt;dataitem&gt;&lt;displayname&gt;Bob&lt;/displayname&gt;&lt;datadesc&gt;Second&lt;/datadesc&gt;&lt;/dataitem&gt;&lt;/recordinfo&gt;</recorditem></appmsg></msg>"#;
        assert_eq!(
            clean_content(xml, 49),
            "[Chat History] Team history\nAlice: Hello & welcome\nBob: Second"
        );
    }

    #[test]
    fn merged_forward_without_items_falls_back_to_title() {
        let xml = r#"<msg><appmsg><title>Empty history</title><type>19</type><recorditem>&lt;recordinfo&gt;&lt;/recordinfo&gt;</recorditem></appmsg></msg>"#;
        assert_eq!(clean_content(xml, 49), "Empty history");
    }

    #[test]
    fn quoted_image_reports_stable_resource_limitation() {
        let xml = r#"<msg><appmsg><refermsg><displayname>Alice</displayname><content>&lt;msg&gt;&lt;img md5=&quot;redacted&quot;/&gt;&lt;/msg&gt;</content></refermsg></appmsg></msg>"#;
        let reply = extract_reply_info(xml, 49).expect("reply");
        assert_eq!(
            reply.media_error_code.as_deref(),
            Some("QUOTED_IMAGE_RESOURCE_UNAVAILABLE")
        );
        assert!(!reply.content.is_empty());
    }

    #[test]
    fn structured_forward_preserves_sender_time_and_nested_children() {
        let xml = r#"<msg><appmsg><title>Thread</title><type>19</type><recorditem>&lt;recordinfo&gt;&lt;dataitem&gt;&lt;sourcename&gt;Alice&lt;/sourcename&gt;&lt;createtime&gt;1700000000&lt;/createtime&gt;&lt;datatitle&gt;Outer&lt;/datatitle&gt;&lt;recorditem&gt;&amp;lt;recordinfo&amp;gt;&amp;lt;dataitem&amp;gt;&amp;lt;displayname&amp;gt;Bob&amp;lt;/displayname&amp;gt;&amp;lt;datadesc&amp;gt;Inner&amp;lt;/datadesc&amp;gt;&amp;lt;/dataitem&amp;gt;&amp;lt;/recordinfo&amp;gt;</recorditem>&lt;/dataitem&gt;&lt;/recordinfo&gt;</recorditem></appmsg></msg>"#;
        let tree = parse_forwarded_tree(xml).expect("tree");
        assert_eq!(tree.title.as_deref(), Some("Thread"));
        assert!(!tree.truncated);
        assert_eq!(tree.nodes.len(), 1);
        assert_eq!(tree.nodes[0].sender.as_deref(), Some("Alice"));
        assert_eq!(tree.nodes[0].timestamp.as_deref(), Some("1700000000"));
        assert_eq!(tree.nodes[0].children[0].sender.as_deref(), Some("Bob"));
        assert_eq!(tree.nodes[0].children[0].text.as_deref(), Some("Inner"));
    }

    #[test]
    fn structured_forward_marks_oversized_input_truncated() {
        let huge = "x".repeat(FORWARD_MAX_XML_BYTES + 1);
        let xml = format!("<msg><appmsg><type>19</type><recorditem>{huge}</recorditem></appmsg></msg>");
        let tree = parse_forwarded_tree(&xml).expect("tree");
        assert!(tree.truncated);
        assert!(tree.nodes.is_empty());
    }

    #[test]
    fn packed_group_image_xml_is_removed() {
        let packed = ((11_i64) << 32) | 0x8000_0003_u32 as i64;
        assert_eq!(clean_content(r#"<msg><img aeskey="redacted"/></msg>"#, packed), "");
    }
}
