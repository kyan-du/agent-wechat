use crate::ia::types::MediaResult;
use crate::tools::wechat_db::{get_db_path, query_wechat_db};
use crate::tools::wechat_message_type::normalize_local_type;
use crate::tools::wechat_messages::{
    collect_forward_dataitems, decode_message_content, extract_xml_tag, find_message_db,
    get_msg_table_name, is_merged_forward_xml, refermsg_referred_xml,
};
use md5::{Digest, Md5};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::Duration;

/// WeChat .dat file magic bytes: 07 08 56 32 08 07
const DAT_MAGIC: [u8; 6] = [0x07, 0x08, 0x56, 0x32, 0x08, 0x07];

struct ImageKeys {
    aes_key_hex: String,
    xor_byte: Option<u8>,
}

fn media_result(
    media_type: &str,
    data: Option<String>,
    format: impl Into<String>,
    filename: impl Into<String>,
) -> MediaResult {
    MediaResult {
        media_type: media_type.into(),
        data,
        url: None,
        format: format.into(),
        filename: filename.into(),
        source: None,
        error_code: None,
        items: Vec::new(),
    }
}

fn unsupported() -> MediaResult {
    let mut result = media_result("unsupported", None, "", "");
    result.error_code = Some("MEDIA_UNSUPPORTED".into());
    result
}

/// Chat history / merged-forward cards are display text, not failed attachments.
fn unsupported_without_error() -> MediaResult {
    media_result("unsupported", None, "", "")
}

fn is_chat_history_appmsg(sub: i32, content: &str) -> bool {
    if sub == 19 {
        return true;
    }
    extract_xml_tag(content, "type").and_then(|value| value.parse::<i32>().ok()) == Some(19)
}

const MAX_NESTED_CHAT_HISTORY_MEDIA: usize = 16;
const NESTED_IMAGE_TYPE: i32 = 2;
const NESTED_VOICE_TYPE: i32 = 3;
const NESTED_VIDEO_TYPE: i32 = 4;
const NESTED_FILE_TYPE: i32 = 8;
const NESTED_VOICE_MSG_TYPE: i32 = 34;
const NESTED_VIDEO_MSG_TYPE: i32 = 43;

fn sanitize_md5(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(value.to_ascii_lowercase())
    } else {
        None
    }
}

fn dataitem_type(item: &str) -> i32 {
    xml_attr(item, "datatype")
        .or_else(|| extract_xml_tag(item, "datatype"))
        .or_else(|| xml_attr(item, "type"))
        .or_else(|| extract_xml_tag(item, "type"))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn nested_payload_md5(item: &str) -> Option<String> {
    for key in ["fullmd5", "md5"] {
        if let Some(value) = xml_attr(item, key).or_else(|| extract_xml_tag(item, key)) {
            if let Some(md5) = sanitize_md5(&value) {
                return Some(md5);
            }
        }
    }
    None
}

fn nested_image_md5(item: &str) -> Option<String> {
    nested_payload_md5(item).or_else(|| {
        xml_attr(item, "thumbfullmd5")
            .or_else(|| extract_xml_tag(item, "thumbfullmd5"))
            .and_then(|value| sanitize_md5(&value))
    })
}

// A Rec filename/dataid is not a content digest. Only publish bytes whose
// digest agrees with the payload's fullmd5/md5, never a thumbnail's digest.
fn read_verified_payload(path: &Path, md5: &str) -> Option<Vec<u8>> {
    if fs::metadata(path).ok()?.len() > MAX_INBOUND_FILE_BYTES {
        return None;
    }
    let data = read_stable_file(path)?;
    (format!("{:x}", Md5::digest(&data)) == md5).then_some(data)
}

fn unique_existing_file(mut paths: Vec<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    paths.retain(|path| path.is_file());
    paths.sort();
    paths.dedup();
    (paths.len() == 1).then(|| paths.pop().expect("unique file"))
}

fn nested_item_time(item: &str, fallback: i64) -> i64 {
    extract_xml_tag(item, "sourcetime")
        .or_else(|| extract_xml_tag(item, "createtime"))
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn media_with_data(result: MediaResult) -> Option<MediaResult> {
    if result.data.as_ref().is_some_and(|data| !data.is_empty()) && result.error_code.is_none() {
        Some(result)
    } else {
        None
    }
}

fn pending_with(
    media_type: &str,
    format: impl Into<String>,
    filename: impl Into<String>,
    code: &str,
) -> MediaResult {
    let mut result = media_result(media_type, None, format, filename);
    result.error_code = Some(code.into());
    result
}

fn pending() -> MediaResult {
    pending_with("pending", "", "", "MEDIA_NOT_DOWNLOADED")
}

fn pending_image(local_id: i64, code: &str) -> MediaResult {
    pending_with("pending", "jpeg", format!("msg_{local_id}.jpg"), code)
}

/// Read a snapshot only after observing the complete file twice across a small
/// stability window. A metadata check surrounding one read is not sufficient:
/// a producer can pause between writes and make a truncated file look stable.
/// Returning `None` is intentional: callers map it to their bounded retry path.
fn read_stable_file(path: &Path) -> Option<Vec<u8>> {
    const STABILITY_WINDOW: Duration = Duration::from_millis(25);

    let first_meta = fs::metadata(path).ok()?;
    if !first_meta.is_file() || first_meta.len() == 0 {
        return None;
    }
    let first = fs::read(path).ok()?;
    if first.len() as u64 != first_meta.len() {
        return None;
    }

    thread::sleep(STABILITY_WINDOW);

    let second_meta = fs::metadata(path).ok()?;
    if !second_meta.is_file() || second_meta.len() == 0 {
        return None;
    }
    let second = fs::read(path).ok()?;
    if second.len() as u64 != second_meta.len()
        || first_meta.len() != second_meta.len()
        || first_meta.modified().ok()? != second_meta.modified().ok()?
        || first != second
    {
        return None;
    }
    Some(second)
}

fn account_base_paths(account_dir: &str) -> Vec<String> {
    if account_dir.starts_with('/') {
        return vec![account_dir.to_string()];
    }
    vec![
        format!("/home/wechat/xwechat_files/{account_dir}"),
        format!("/home/wechat/Documents/xwechat_files/{account_dir}"),
    ]
}

fn is_quoted_image_xml(xml: &str) -> bool {
    xml.contains("<img") && !is_merged_forward_xml(xml)
}

fn is_quoted_file_xml(xml: &str) -> bool {
    extract_xml_tag(xml, "type").and_then(|value| value.parse::<i32>().ok()) == Some(6)
}

fn is_quoted_voice_xml(xml: &str) -> bool {
    xml.contains("<voicemsg")
}

fn is_quoted_video_xml(xml: &str) -> bool {
    xml.contains("<videomsg")
}

fn rec_kind_suffixes(kind: &str) -> &'static [&'static str] {
    match kind {
        "Video" | "Vid" => &[".mp4"],
        "Voic" | "Voice" => &[".silk", ".mp3"],
        _ => &[".dat", ".pdf", ".docx"],
    }
}

fn find_rec_named_file(base: &Path, kind: &str, stem: &str) -> Option<std::path::PathBuf> {
    let attach = base.join("msg/attach");
    if !attach.is_dir() {
        return None;
    }
    let Ok(chat_dirs) = fs::read_dir(&attach) else {
        return None;
    };
    let mut chats: Vec<_> = chat_dirs
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    chats.sort();
    let mut found = Vec::new();
    for chat in chats {
        let Ok(month_dirs) = fs::read_dir(&chat) else {
            continue;
        };
        let mut months: Vec<_> = month_dirs
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        months.sort();
        for month in months {
            let rec_root = month.join("Rec");
            let Ok(rec_dirs) = fs::read_dir(&rec_root) else {
                continue;
            };
            let mut recs: Vec<_> = rec_dirs
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            recs.sort();
            for rec in recs {
                let dir = rec.join(kind);
                if !dir.is_dir() {
                    continue;
                }
                let exact = dir.join(stem);
                if exact.is_file() {
                    found.push(exact);
                    continue;
                }
                for suffix in rec_kind_suffixes(kind) {
                    let candidate = dir.join(format!("{stem}{suffix}"));
                    if candidate.is_file() {
                        found.push(candidate);
                    }
                }
            }
        }
    }
    unique_existing_file(found)
}

fn encode_media_bytes(
    media_type: &str,
    data: &[u8],
    format: impl Into<String>,
    filename: impl Into<String>,
) -> MediaResult {
    media_result(
        media_type,
        Some(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            data,
        )),
        format,
        filename,
    )
}

/// Look up a single message's raw content by localId.
fn lookup_message_raw(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    local_id: i64,
) -> Option<(i64, i64, String)> {
    let table_name = get_msg_table_name(chat_id);
    let (db_name, key) = find_message_db(account_dir, keys, chat_id)?;
    let db_path = get_db_path(account_dir, &db_name);

    let rows = query_wechat_db(
        &db_path,
        key,
        &format!(
            "SELECT local_type, create_time,
                    hex(message_content) as hex_content,
                    WCDB_CT_message_content as is_compressed
             FROM \"{table_name}\"
             WHERE local_id = {local_id}
             LIMIT 1;"
        ),
    );

    let row = rows.first()?;
    let local_type = row.get("local_type")?.as_i64()?;
    let create_time = row.get("create_time").and_then(|v| v.as_i64()).unwrap_or(0);
    let hex_content = row
        .get("hex_content")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let is_compressed = row
        .get("is_compressed")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        != 0;

    let content = decode_message_content(hex_content, is_compressed);
    // Strip group sender prefix
    let body = if let Some(idx) = content.find(":\n") {
        if idx < 80 {
            content[idx + 2..].to_string()
        } else {
            content
        }
    } else {
        content
    };

    Some((local_type, create_time, body))
}

/// Extract an XML attribute value.
fn xml_attr(xml: &str, attr: &str) -> Option<String> {
    let pat = format!("{attr}=\"");
    let start = xml
        .match_indices(&pat)
        .find(|(index, _)| *index > 0 && xml.as_bytes()[index - 1].is_ascii_whitespace())?
        .0
        + pat.len();
    let end = xml[start..].find('"')? + start;
    let val = xml[start..end].trim().to_string();
    if val.is_empty() {
        None
    } else {
        Some(val)
    }
}

// ── Image thumbnail from filesystem cache ────────────────────────────────────

fn get_image_thumbnail(
    account_dir: &str,
    chat_id: &str,
    local_id: i64,
    create_time: i64,
) -> Option<MediaResult> {
    let hash = format!("{:x}", Md5::digest(chat_id.as_bytes()));
    let dt = chrono::DateTime::from_timestamp(create_time, 0)?;
    let year_month = dt.format("%Y-%m").to_string();
    let thumb_name = format!("{local_id}_{create_time}_thumb.jpg");

    for base in &account_base_paths(account_dir) {
        let thumb_path = Path::new(base)
            .join("cache")
            .join(&year_month)
            .join("Message")
            .join(&hash)
            .join("Thumb")
            .join(&thumb_name);
        if thumb_path.exists() {
            if let Some(data) = read_stable_file(&thumb_path) {
                return Some(MediaResult {
                    media_type: "image".into(),
                    data: Some(base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &data,
                    )),
                    url: None,
                    format: "jpeg".into(),
                    filename: format!("msg_{local_id}.jpg"),
                    source: None,
                    error_code: None,
                    items: Vec::new(),
                });
            }
        }
    }
    None
}

// ── .dat file decryption ─────────────────────────────────────────────────────

fn aligned_aes_size(enc_chunk_size: u32) -> u32 {
    let rem = enc_chunk_size % 16;
    if rem == 0 {
        enc_chunk_size + 16
    } else {
        enc_chunk_size + (16 - rem)
    }
}

fn decrypt_dat_head(dat: &[u8], aes_key_hex: &str) -> Option<(Vec<u8>, u32)> {
    if dat.len() < 15 || dat[..6] != DAT_MAGIC {
        return None;
    }
    let enc_chunk_size = u32::from_le_bytes(dat[6..10].try_into().ok()?);
    let aes_key = &aes_key_hex.as_bytes()[..16]; // first 16 ASCII chars

    let aligned = aligned_aes_size(enc_chunk_size) as usize;
    if dat.len() < 15 + aligned {
        return None;
    }
    let ct = &dat[15..15 + aligned];

    // AES-128-ECB decrypt via openssl CLI (no native Rust AES dep needed)
    let mut child = Command::new("openssl")
        .args(["enc", "-d", "-aes-128-ecb", "-K"])
        .arg(hex_encode(aes_key))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    use std::io::Write;
    child.stdin.take()?.write_all(ct).ok()?;
    let output = child.wait_with_output().ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }

    Some((output.stdout, enc_chunk_size))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
}

fn derive_xor_byte(dat: &[u8], dec_head: &[u8]) -> Option<u8> {
    if dec_head.len() >= 2 && dec_head[0] == 0xff && dec_head[1] == 0xd8 {
        // JPEG: last 2 bytes should be FF D9
        let c1 = dat[dat.len() - 2] ^ 0xFF;
        let c2 = dat[dat.len() - 1] ^ 0xD9;
        if c1 == c2 {
            return Some(c1);
        }
    }
    if dec_head.len() >= 4 && dec_head[..4] == [0x89, 0x50, 0x4e, 0x47] {
        // PNG: last 8 bytes are IEND chunk
        let expected = [0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];
        if dat.len() >= 8 {
            let ts = dat.len() - 8;
            let xb = dat[ts] ^ expected[0];
            if expected
                .iter()
                .enumerate()
                .all(|(i, &e)| (dat[ts + i] ^ xb) == e)
            {
                return Some(xb);
            }
        }
    }
    if dec_head.len() >= 4 && &dec_head[..4] == b"GIF8" {
        // GIF: last 2 bytes are 00 3B
        let c1 = dat[dat.len() - 2] ^ 0x00;
        let c2 = dat[dat.len() - 1] ^ 0x3B;
        if c1 == c2 {
            return Some(c1);
        }
    }
    None
}

fn is_dat_thumbnail_name(name: &str) -> bool {
    name.ends_with("_t.dat") || name.ends_with("_t")
}

fn resolve_xor_byte(dat_path: &str, dat: &[u8], image_keys: &ImageKeys) -> Option<u8> {
    if let Some(xb) = image_keys.xor_byte {
        return Some(xb);
    }
    let (dec_head, _) = decrypt_dat_head(dat, &image_keys.aes_key_hex)?;
    let xb = derive_xor_byte(dat, &dec_head);
    if xb.is_some() {
        return xb;
    }
    // Try sibling thumbnail files (JPEG thumbs are reliable for XOR derivation).
    // Ordinary Img uses `{hash}_t.dat`; Rec 聊天记录 uses bare `{n}_t`.
    let dir = Path::new(dat_path).parent()?;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_dat_thumbnail_name(&name) {
                continue;
            }
            if let Some(sib) = read_stable_file(&entry.path()) {
                if sib.len() < 15 || sib[..6] != DAT_MAGIC {
                    continue;
                }
                if let Some((sib_head, _)) = decrypt_dat_head(&sib, &image_keys.aes_key_hex) {
                    if let Some(xb) = derive_xor_byte(&sib, &sib_head) {
                        return Some(xb);
                    }
                }
            }
        }
    }
    None
}

fn decrypt_dat(dat: &[u8], aes_key_hex: &str, xor_byte: u8) -> Option<Vec<u8>> {
    let (dec_head, enc_chunk_size) = decrypt_dat_head(dat, aes_key_hex)?;
    let xor_size = u32::from_le_bytes(dat[10..14].try_into().ok()?) as usize;
    let aes_ct_end = 15 + aligned_aes_size(enc_chunk_size) as usize;
    let remaining = &dat[aes_ct_end..];

    let raw_length = remaining.len().saturating_sub(xor_size);
    let raw_data = &remaining[..raw_length];
    let xor_data = &remaining[raw_length..];

    let dec_tail: Vec<u8> = xor_data.iter().map(|b| b ^ xor_byte).collect();

    let mut result = Vec::with_capacity(dec_head.len() + raw_data.len() + dec_tail.len());
    result.extend_from_slice(&dec_head);
    result.extend_from_slice(raw_data);
    result.extend_from_slice(&dec_tail);
    Some(result)
}

fn detect_image_format(data: &[u8]) -> (&'static str, &'static str) {
    if data.len() >= 2 && data[0] == 0xff && data[1] == 0xd8 {
        return ("jpeg", "jpg");
    }
    if data.len() >= 4 && data[..4] == [0x89, 0x50, 0x4e, 0x47] {
        return ("png", "png");
    }
    if data.len() >= 4 && &data[..4] == b"GIF8" {
        return ("gif", "gif");
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return ("webp", "webp");
    }
    if data.len() >= 4 && &data[..4] == b"wxgf" {
        return ("wxgf", "wxgf");
    }
    ("unknown", "bin")
}

/// Convert media via the media-convert tool.
fn convert_media(mode: &str, input: &[u8]) -> Option<(Vec<u8>, String)> {
    use std::io::Write;
    let mut child = Command::new("media-convert")
        .arg(mode)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(input).ok()?;
    let output = child.wait_with_output().ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let format = stderr
        .lines()
        .find_map(|l| l.strip_prefix("FORMAT:"))
        .unwrap_or(if mode == "silk2mp3" { "mp3" } else { "jpeg" })
        .to_string();
    Some((output.stdout, format))
}

// ── .dat file resolution via hardlink.db ─────────────────────────────────────

/// Resolve on-disk path for a hardlink image under
/// `msg/attach/<chat>/<yyyy-mm>/`.
///
/// Prefer ordinary `Img/{file_name}` (with optional `.dat`), then scan
/// `Rec/*/Img/{file_name}` used by WeChat 聊天记录 nested images (often bare
/// `0`/`1`/`2` with no `.dat` suffix). Rec is only walked when Img misses.
fn rec_dat_size_matches(path: &Path, expected_file_size: u64) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let len = meta.len();
    // hardlink.file_size is the logical payload length; on-disk Rec `.dat`
    // frames are typically a few dozen bytes larger (AES/XOR header+tail).
    len == expected_file_size
        || (len > expected_file_size && len - expected_file_size <= 64)
}

fn resolve_hardlink_dat_path(
    base: &Path,
    chat_dir: &str,
    date_dir: &str,
    file_name: &str,
    expected_file_size: Option<u64>,
) -> Option<std::path::PathBuf> {
    let month = base.join("msg/attach").join(chat_dir).join(date_dir);
    let names: Vec<String> = if file_name.ends_with(".dat") {
        vec![file_name.to_string()]
    } else {
        vec![file_name.to_string(), format!("{file_name}.dat")]
    };

    for name in &names {
        let candidate = month.join("Img").join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let rec_root = month.join("Rec");
    if let Ok(entries) = fs::read_dir(&rec_root) {
        // Stable order for tests / determinism.
        let mut dirs: Vec<_> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        for rec_dir in dirs {
            for name in &names {
                let candidate = rec_dir.join("Img").join(name);
                if candidate.is_file() {
                    found.push(candidate);
                }
            }
        }
        match found.len() {
            0 => None,
            1 => Some(found.pop().expect("one Rec path")),
            _ => {
                // Numeric Rec names (0/1/2) are local to a card. When several
                // 聊天记录 cards share a chat+month, disambiguate with the
                // hardlink row's file_size; refuse if still ambiguous.
                let expected = expected_file_size?;
                found.retain(|path| rec_dat_size_matches(path, expected));
                (found.len() == 1).then(|| found.pop().expect("unique size match"))
            }
        }
    } else {
        None
    }
}

fn find_dat_via_hardlink(
    account_dir: &str,
    keys: &HashMap<String, String>,
    _chat_id: &str,
    content: &str,
) -> Option<String> {
    let hardlink_key = match keys.get("hardlink.db") {
        Some(k) => k,
        None => {
            tracing::warn!("[media:hardlink] no key for hardlink.db");
            return None;
        }
    };
    let image_md5 = match xml_attr(content, "md5") {
        Some(m) => m,
        None => {
            tracing::warn!(
                "[media:hardlink] no md5 attr in content (len={})",
                content.len()
            );
            return None;
        }
    };
    let hardlink_db = get_db_path(account_dir, "hardlink.db");

    let file_rows = query_wechat_db(
        &hardlink_db,
        hardlink_key,
        &format!(
            "SELECT file_name, file_size, dir1, dir2 FROM image_hardlink_info_v4
             WHERE md5 = '{image_md5}' LIMIT 2;"
        ),
    );
    if file_rows.len() != 1 {
        tracing::warn!(
            "[media:hardlink] ambiguous or missing hardlink row count={}",
            file_rows.len()
        );
        return None;
    }
    let row = &file_rows[0];
    let file_name = row.get("file_name")?.as_str()?;
    let file_size = row.get("file_size").and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n as u64)));
    let dir1 = row.get("dir1")?.as_i64()?;
    let dir2 = row.get("dir2")?.as_i64()?;

    let dir_rows = query_wechat_db(
        &hardlink_db,
        hardlink_key,
        &format!("SELECT rowid, username FROM dir2id WHERE rowid IN ({dir1}, {dir2});"),
    );
    let dir_map: HashMap<i64, String> = dir_rows
        .iter()
        .filter_map(|r| {
            let rid = r.get("rowid")?.as_i64()?;
            let name = r.get("username")?.as_str()?.to_string();
            Some((rid, name))
        })
        .collect();

    let chat_dir = dir_map.get(&dir1)?;
    let date_dir = dir_map.get(&dir2)?;

    for base in &account_base_paths(account_dir) {
        if let Some(dat_path) =
            resolve_hardlink_dat_path(Path::new(base), chat_dir, date_dir, file_name, file_size)
        {
            return Some(dat_path.to_string_lossy().to_string());
        }
    }
    tracing::warn!("[media:hardlink] dat file not found md5_present=true");
    None
}

/// Look up the file hash for a message from message_resource.db.
/// Returns the 32-char hex hash used in filenames on disk.
fn find_file_hash_via_resource_db(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    local_id: i64,
) -> Option<String> {
    let resource_key = keys.get("message_resource.db")?;
    let resource_db = get_db_path(account_dir, "message_resource.db");

    // Look up chat_id integer from ChatName2Id
    let chat_rows = query_wechat_db(
        &resource_db,
        resource_key,
        &format!(
            "SELECT rowid FROM ChatName2Id WHERE user_name = '{}' LIMIT 1;",
            chat_id.replace('\'', "''")
        ),
    );
    let chat_id_int = chat_rows.first()?.get("rowid")?.as_i64()?;

    // Query packed_info from MessageResourceInfo
    let info_rows = query_wechat_db(
        &resource_db,
        resource_key,
        &format!(
            "SELECT hex(packed_info) as hex_info FROM MessageResourceInfo
             WHERE chat_id = {chat_id_int} AND message_local_id = {local_id}
             LIMIT 1;"
        ),
    );
    let hex_info = info_rows.first()?.get("hex_info")?.as_str()?.to_string();

    let file_hash = extract_file_hash_from_packed_info(&hex_info)?;
    tracing::info!("[media:resource-db] file hash resolved message_ref_present=true");
    Some(file_hash)
}

/// Look up the .dat filename from message_resource.db. The packed_info blob in
/// MessageResourceInfo contains the file hash used as the .dat filename.
fn find_dat_via_resource_db(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    local_id: i64,
    create_time: i64,
) -> Option<String> {
    let file_hash = find_file_hash_via_resource_db(account_dir, keys, chat_id, local_id)?;

    // Build path: msg/attach/<md5(chatId)>/<year-month>/Img/<hash>.dat
    let chat_hash = format!("{:x}", Md5::digest(chat_id.as_bytes()));
    let dt = chrono::DateTime::from_timestamp(create_time, 0)?;
    let year_month = dt.format("%Y-%m").to_string();

    for base in &account_base_paths(account_dir) {
        // Try mid-res .dat first, then _t.dat thumbnail
        for suffix in &["", "_t"] {
            let dat_path = Path::new(base)
                .join("msg/attach")
                .join(&chat_hash)
                .join(&year_month)
                .join("Img")
                .join(format!("{file_hash}{suffix}.dat"));
            if dat_path.exists() {
                return Some(dat_path.to_string_lossy().to_string());
            }
        }
    }

    tracing::warn!("[media:resource-db] file not on disk hash_present=true");
    None
}

/// Get video data: .mp4 if downloaded, otherwise cover .jpg or _thumb.jpg.
/// Videos are stored unencrypted at msg/video/{YYYY-MM}/{hash}.mp4
fn get_video_data(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    local_id: i64,
    create_time: i64,
) -> MediaResult {
    let dt = match chrono::DateTime::from_timestamp(create_time, 0) {
        Some(dt) => dt,
        None => return unsupported(),
    };
    let year_month = dt.format("%Y-%m").to_string();

    // Try to get file hash from message_resource.db
    let file_hash = find_file_hash_via_resource_db(account_dir, keys, chat_id, local_id);

    if let Some(ref hash) = file_hash {
        for base in &account_base_paths(account_dir) {
            let video_dir = Path::new(base).join("msg/video").join(&year_month);

            // Try .mp4 first (full video)
            let mp4_path = video_dir.join(format!("{hash}.mp4"));
            if mp4_path.exists() {
                if let Ok(data) = fs::read(&mp4_path) {
                    tracing::info!("[media:video] found mp4 size={}", data.len());
                    return MediaResult {
                        media_type: "video".into(),
                        data: Some(base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            &data,
                        )),
                        url: None,
                        format: "mp4".into(),
                        filename: format!("msg_{local_id}.mp4"),
                        source: None,
                        error_code: None,
                        items: Vec::new(),
                    };
                }
            }

            // Try cover .jpg (full-size cover image)
            let cover_path = video_dir.join(format!("{hash}.jpg"));
            if cover_path.exists() {
                if let Ok(data) = fs::read(&cover_path) {
                    tracing::info!("[media:video] found cover");
                    return MediaResult {
                        media_type: "video".into(),
                        data: Some(base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            &data,
                        )),
                        url: None,
                        format: "jpeg".into(),
                        filename: format!("msg_{local_id}_cover.jpg"),
                        source: None,
                        error_code: None,
                        items: Vec::new(),
                    };
                }
            }

            // Try _thumb.jpg
            let thumb_path = video_dir.join(format!("{hash}_thumb.jpg"));
            if thumb_path.exists() {
                if let Ok(data) = fs::read(&thumb_path) {
                    tracing::info!("[media:video] found thumb");
                    return MediaResult {
                        media_type: "video".into(),
                        data: Some(base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            &data,
                        )),
                        url: None,
                        format: "jpeg".into(),
                        filename: format!("msg_{local_id}_thumb.jpg"),
                        source: None,
                        error_code: None,
                        items: Vec::new(),
                    };
                }
            }
        }
    }

    // Fallback: try cached thumbnail from WeChat's cache dir
    if let Some(thumb) = get_image_thumbnail(account_dir, chat_id, local_id, create_time) {
        return thumb;
    }

    // Video exists but no file found on disk yet
    tracing::warn!("[media:video] no video file found message_ref_present=true");
    pending()
}

/// Extract the 32-char hex file hash from a MessageResourceInfo packed_info blob.
/// The blob is protobuf-encoded: field 2 (tag 0x12), length-delimited, containing
/// field 1 (tag 0x0A), 32 bytes of ASCII hex hash.
fn extract_file_hash_from_packed_info(hex_info: &str) -> Option<String> {
    let bytes = crate::tools::wechat_messages::hex_decode(hex_info)?;
    // Find the ASCII hex hash: 32 chars [0-9a-f]
    // It's at a fixed offset in the protobuf, but let's be robust and scan for it
    for window in bytes.windows(32) {
        if window.iter().all(|&b| b.is_ascii_hexdigit()) {
            let candidate = std::str::from_utf8(window).ok()?;
            // Verify it's lowercase hex (not random ASCII digits)
            if candidate
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
            {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

fn decrypt_and_return(dat_path: &str, image_keys: &ImageKeys, local_id: i64) -> MediaResult {
    let dat = match read_stable_file(Path::new(dat_path)) {
        Some(d) => d,
        None => return pending_image(local_id, "IMAGE_NOT_STABLE"),
    };

    let xor_byte = match resolve_xor_byte(dat_path, &dat, image_keys) {
        Some(xb) => xb,
        None => return pending_image(local_id, "IMAGE_XOR_KEY_UNAVAILABLE"),
    };

    let decrypted = match decrypt_dat(&dat, &image_keys.aes_key_hex, xor_byte) {
        Some(d) => d,
        None => return pending_image(local_id, "IMAGE_DECRYPTION_FAILED"),
    };

    let (format, ext) = detect_image_format(&decrypted);

    // WXGF → convert via ffmpeg, fall back to thumbnail
    if format == "wxgf" {
        if let Some((converted, cfmt)) = convert_media("wxgf2img", &decrypted) {
            let cext = if cfmt == "jpeg" {
                "jpg".to_string()
            } else {
                cfmt.clone()
            };
            return MediaResult {
                media_type: "image".into(),
                data: Some(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    &converted,
                )),
                url: None,
                format: cfmt,
                filename: format!("msg_{local_id}.{cext}"),
                source: None,
                error_code: None,
                items: Vec::new(),
            };
        }
        // Try _t.dat thumbnail
        let thumb_path = dat_path.replace(".dat", "_t.dat");
        if Path::new(&thumb_path).exists() {
            if let Some(thumb_dat) = read_stable_file(Path::new(&thumb_path)) {
                if let Some(xb2) = resolve_xor_byte(&thumb_path, &thumb_dat, image_keys) {
                    if let Some(dec) = decrypt_dat(&thumb_dat, &image_keys.aes_key_hex, xb2) {
                        let (tf, te) = detect_image_format(&dec);
                        return MediaResult {
                            media_type: "image".into(),
                            data: Some(base64::Engine::encode(
                                &base64::engine::general_purpose::STANDARD,
                                &dec,
                            )),
                            url: None,
                            format: tf.into(),
                            filename: format!("msg_{local_id}.{te}"),
                            source: Some("thumbnail".into()),
                            error_code: None,
                            items: Vec::new(),
                        };
                    }
                }
            }
        }
    }

    MediaResult {
        media_type: "image".into(),
        data: Some(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &decrypted,
        )),
        url: None,
        format: format.into(),
        filename: format!("msg_{local_id}.{ext}"),
        source: Some("original".into()),
        error_code: None,
        items: Vec::new(),
    }
}

// ── Emoji ────────────────────────────────────────────────────────────────────

fn get_emoji_media(
    account_dir: &str,
    keys: &HashMap<String, String>,
    content: &str,
    _local_id: i64,
) -> MediaResult {
    let md5_val = match xml_attr(content, "md5") {
        Some(m) => m,
        None => return unsupported(),
    };

    // Look up CDN URL from emoticon.db
    if let Some(emoticon_key) = keys.get("emoticon.db") {
        let emoticon_db = get_db_path(account_dir, "emoticon.db");
        let rows = query_wechat_db(
            &emoticon_db,
            emoticon_key,
            &format!("SELECT cdn_url FROM kNonStoreEmoticonTable WHERE md5 = '{md5_val}' LIMIT 1;"),
        );
        if let Some(row) = rows.first() {
            if let Some(url) = row.get("cdn_url").and_then(|v| v.as_str()) {
                if !url.is_empty() {
                    return MediaResult {
                        media_type: "emoji".into(),
                        data: None,
                        url: Some(url.to_string()),
                        format: "gif".into(),
                        filename: format!("emoji_{md5_val}.gif"),
                        source: None,
                        error_code: None,
                        items: Vec::new(),
                    };
                }
            }
        }
    }

    // Fallback: extract cdnurl from message XML
    if let Some(url) = xml_attr(content, "cdnurl") {
        if url.starts_with("http") {
            return MediaResult {
                media_type: "emoji".into(),
                data: None,
                url: Some(url),
                format: "gif".into(),
                filename: format!("emoji_{md5_val}.gif"),
                source: None,
                error_code: None,
                items: Vec::new(),
            };
        }
    }

    MediaResult {
        media_type: "emoji".into(),
        data: None,
        url: None,
        format: "unknown".into(),
        filename: format!("emoji_{md5_val}"),
        source: None,
        error_code: None,
        items: Vec::new(),
    }
}

// ── Voice ────────────────────────────────────────────────────────────────────

fn get_voice_data(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    local_id: i64,
) -> MediaResult {
    // Try media_0.db, media_1.db, etc.
    let mut media_dbs: Vec<(&str, &str)> = keys
        .iter()
        .filter(|(k, _)| k.starts_with("media_") && k.ends_with(".db"))
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    media_dbs.sort_by_key(|(k, _)| k.to_string());

    for (db_name, media_key) in &media_dbs {
        let media_db = get_db_path(account_dir, db_name);

        let name_rows = query_wechat_db(
            &media_db,
            media_key,
            &format!(
                "SELECT rowid FROM Name2Id WHERE user_name = '{}';",
                chat_id.replace('\'', "''")
            ),
        );
        let chat_name_id = match name_rows.first().and_then(|r| r.get("rowid")?.as_i64()) {
            Some(id) => id,
            None => continue,
        };

        let voice_rows = query_wechat_db(
            &media_db,
            media_key,
            &format!(
                "SELECT hex(voice_data) as hex_data FROM VoiceInfo
                 WHERE chat_name_id = {chat_name_id} AND local_id = {local_id}
                 LIMIT 1;"
            ),
        );
        let hex_data = match voice_rows.first().and_then(|r| r.get("hex_data")?.as_str()) {
            Some(h) if !h.is_empty() => h.to_string(),
            _ => continue,
        };

        let silk_bytes = match crate::tools::wechat_messages::hex_decode(&hex_data) {
            Some(b) => b,
            None => continue,
        };

        // Try SILK → MP3 conversion
        if let Some((mp3, _)) = convert_media("silk2mp3", &silk_bytes) {
            return MediaResult {
                media_type: "voice".into(),
                data: Some(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    &mp3,
                )),
                url: None,
                format: "mp3".into(),
                filename: format!("msg_{local_id}.mp3"),
                source: None,
                error_code: None,
                items: Vec::new(),
            };
        }

        // Fall back to raw SILK
        return MediaResult {
            media_type: "voice".into(),
            data: Some(base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                &silk_bytes,
            )),
            url: None,
            format: "silk".into(),
            filename: format!("msg_{local_id}.silk"),
            source: None,
            error_code: None,
            items: Vec::new(),
        };
    }

    pending_with(
        "voice",
        "",
        format!("msg_{local_id}"),
        "VOICE_NOT_DOWNLOADED",
    )
}

// ── File attachment ──────────────────────────────────────────────────────────

const MAX_INBOUND_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_INBOUND_FILENAME_CHARS: usize = 180;

fn sanitize_inbound_filename(raw: &str, local_id: i64) -> String {
    let normalized = raw.replace('\\', "/");
    let basename = Path::new(&normalized)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let mut cleaned = String::new();
    for ch in basename
        .chars()
        .filter(|ch| !ch.is_control() && *ch != '/' && *ch != '\\')
        .take(MAX_INBOUND_FILENAME_CHARS)
    {
        if cleaned.len() + ch.len_utf8() > 240 {
            break;
        }
        cleaned.push(ch);
    }
    let cleaned = cleaned.trim_matches(|ch: char| ch.is_whitespace() || ch == '.');
    if cleaned.is_empty() {
        format!("file_{local_id}")
    } else {
        cleaned.to_string()
    }
}

fn get_file_attachment(
    account_dir: &str,
    content: &str,
    create_time: i64,
    local_id: i64,
) -> MediaResult {
    let raw_filename = extract_xml_tag(content, "title").unwrap_or_default();
    let filename = sanitize_inbound_filename(&raw_filename, local_id);
    let ext = Path::new(&filename)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .or_else(|| extract_xml_tag(content, "fileext").map(|value| value.to_ascii_lowercase()))
        .unwrap_or_default();
    let Some(dt) = chrono::DateTime::from_timestamp(create_time, 0) else {
        return pending_with("file", ext, filename, "FILE_TIMESTAMP_INVALID");
    };
    let year_month = dt.format("%Y-%m").to_string();

    for base in &account_base_paths(account_dir) {
        let file_path = Path::new(base)
            .join("msg/file")
            .join(&year_month)
            .join(&filename);
        let Ok(metadata) = fs::metadata(&file_path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() == 0 {
            return pending_with("file", ext, filename, "FILE_EMPTY");
        }
        if metadata.len() > MAX_INBOUND_FILE_BYTES {
            return pending_with("file", ext, filename, "FILE_TOO_LARGE");
        }
        return match read_stable_file(&file_path) {
            Some(data) => media_result(
                "file",
                Some(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    &data,
                )),
                ext,
                filename,
            ),
            None => pending_with("file", ext, filename, "FILE_NOT_STABLE"),
        };
    }

    pending_with("file", ext, filename, "FILE_NOT_DOWNLOADED")
}

fn find_dat_via_md5_filename(account_dir: &str, md5: &str) -> Option<String> {
    let md5 = md5.to_ascii_lowercase();
    let mut found = Vec::new();
    for base in &account_base_paths(account_dir) {
        let attach = Path::new(base).join("msg/attach");
        if !attach.exists() {
            continue;
        }
        // Shallow walk: attach/<chat>/<yyyy-mm>/Img/<hash>.dat
        // and Rec/*/Img/<hash>.dat for nested 聊天记录 images.
        let Ok(chat_dirs) = fs::read_dir(&attach) else {
            continue;
        };
        for chat_entry in chat_dirs.flatten() {
            let Ok(month_dirs) = fs::read_dir(chat_entry.path()) else {
                continue;
            };
            for month_entry in month_dirs.flatten() {
                let month_path = month_entry.path();
                let img_dir = month_path.join("Img");
                if img_dir.is_dir() {
                    let candidate = img_dir.join(format!("{md5}.dat"));
                    if candidate.is_file() {
                        found.push(candidate);
                    }
                }
                let rec_root = month_path.join("Rec");
                if let Ok(rec_dirs) = fs::read_dir(&rec_root) {
                    let mut dirs: Vec<_> = rec_dirs
                        .flatten()
                        .map(|e| e.path())
                        .filter(|p| p.is_dir())
                        .collect();
                    dirs.sort();
                    for rec_dir in dirs {
                        let img_dir = rec_dir.join("Img");
                        if !img_dir.is_dir() {
                            continue;
                        }
                        let candidate = img_dir.join(format!("{md5}.dat"));
                        if candidate.is_file() {
                            found.push(candidate);
                        }
                    }
                }
            }
        }
    }
    unique_existing_file(found).map(|path| path.to_string_lossy().to_string())
}

/// Nested 聊天记录 images resolve via local hardlink / md5 `.dat` only.
/// HTTP CDN fallback was removed: nested fileids are opaque and aeskey is often
/// absent, so CDN never worked in practice.
///
/// When Rec/*/Img files are missing, POST /api/chats/{id}/materialize-chat-history
/// (AT-SPI: open chat → focus Messages → Page_Up/Down → double-click left side of
/// the Chat History card) materializes them. get_chat_history_media returns a
/// retryable pending result with CHAT_HISTORY_NOT_MATERIALIZED so OpenClaw polls
/// again after the GUI plan runs.

fn get_nested_image(
    account_dir: &str,
    keys: &HashMap<String, String>,
    item: &str,
    local_id: i64,
    index: usize,
    image_keys: Option<&ImageKeys>,
) -> Option<MediaResult> {
    // Nested originals require a full-content hash. thumbfullmd5 is a preview
    // digest and must not select a different cached .dat as the payload.
    let md5 = nested_payload_md5(item);

    // Local .dat via hardlink (incl. Rec/*/Img) / md5 filename + session image keys.
    if let (Some(md5), Some(image_keys)) = (md5.as_ref(), image_keys) {
        let lookup_xml = format!(r#"<img md5="{md5}"/>"#);
        let dat_path = find_dat_via_hardlink(account_dir, keys, "", &lookup_xml)
            .or_else(|| find_dat_via_md5_filename(account_dir, md5));
        let Some(dat_path) = dat_path else {
            tracing::warn!(
                "[media:nested-image] no dat path local_id={local_id} index={index} md5={md5}"
            );
            return None;
        };
        let mut result = decrypt_and_return(&dat_path, image_keys, local_id);
        if result.data.is_some() {
            let ext = Path::new(&result.filename)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("jpg")
                .to_string();
            result.filename = format!("chat_history_{local_id}_{index}.{ext}");
            result.source = Some("local-dat".into());
            if let Some(media) = media_with_data(result) {
                return Some(media);
            }
            tracing::warn!(
                "[media:nested-image] media_with_data rejected local_id={local_id} index={index}"
            );
        } else {
            tracing::warn!(
                "[media:nested-image] decrypt failed local_id={local_id} index={index} path={dat_path} code={:?}",
                result.error_code
            );
        }
    }

    None
}

fn get_nested_file(
    account_dir: &str,
    item: &str,
    local_id: i64,
    index: usize,
    fallback_time: i64,
) -> Option<MediaResult> {
    let raw_filename = extract_xml_tag(item, "datatitle")
        .or_else(|| extract_xml_tag(item, "title"))
        .unwrap_or_default();
    let filename = sanitize_inbound_filename(&raw_filename, local_id);
    let md5 = nested_payload_md5(item)?;
    let create_time = nested_item_time(item, fallback_time);
    let dt = chrono::DateTime::from_timestamp(create_time, 0)?;
    for base in account_base_paths(account_dir) {
        let candidates = [
            find_rec_named_file(Path::new(&base), "File", &md5),
            find_rec_named_file(Path::new(&base), "Files", &md5),
            Some(
                Path::new(&base)
                    .join("msg/file")
                    .join(dt.format("%Y-%m").to_string())
                    .join(&filename),
            ),
        ];
        for path in candidates.into_iter().flatten() {
            let Some(data) = read_verified_payload(&path, &md5) else {
                continue;
            };
            let ext = Path::new(&filename)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("bin");
            let mut result = encode_media_bytes(
                "file",
                &data,
                ext,
                format!("chat_history_{local_id}_{index}_{filename}"),
            );
            result.source = Some("local-verified".into());
            return media_with_data(result);
        }
    }
    None
}

fn get_nested_voice(
    account_dir: &str,
    item: &str,
    local_id: i64,
    index: usize,
) -> Option<MediaResult> {
    let md5 = nested_payload_md5(item)?;
    for base in account_base_paths(account_dir) {
        let Some(path) = find_rec_named_file(Path::new(&base), "Voic", &md5)
            .or_else(|| find_rec_named_file(Path::new(&base), "Voice", &md5))
        else {
            continue;
        };
        let Some(data) = read_verified_payload(&path, &md5) else {
            continue;
        };
        let silk = data.strip_prefix(&[0x02]).unwrap_or(&data);
        if silk.starts_with(b"#!SILK_V3") {
            if let Some((mp3, _)) = convert_media("silk2mp3", &data) {
                let mut result = encode_media_bytes(
                    "voice",
                    &mp3,
                    "mp3",
                    format!("chat_history_{local_id}_{index}.mp3"),
                );
                result.source = Some("local-rec".into());
                return media_with_data(result);
            }
        }
        if data.starts_with(b"ID3")
            || (data.len() >= 2 && data[0] == 0xff && data[1] & 0xe0 == 0xe0)
        {
            let mut result = encode_media_bytes(
                "voice",
                &data,
                "mp3",
                format!("chat_history_{local_id}_{index}.mp3"),
            );
            result.source = Some("local-rec".into());
            return media_with_data(result);
        }
        // Conversion failure remains unresolved; raw SILK cannot be delivered
        // as playable MPEG by the inbound pipeline.
    }
    None
}

fn get_nested_video(
    account_dir: &str,
    item: &str,
    local_id: i64,
    index: usize,
) -> Option<MediaResult> {
    let md5 = nested_payload_md5(item)?;
    for base in account_base_paths(account_dir) {
        let Some(path) = find_rec_named_file(Path::new(&base), "Video", &md5)
            .or_else(|| find_rec_named_file(Path::new(&base), "Vid", &md5))
        else {
            continue;
        };
        let Some(data) = read_verified_payload(&path, &md5) else {
            continue;
        };
        // A JPEG cover must not count as a resolved video.
        if data.len() < 12 || &data[4..8] != b"ftyp" {
            continue;
        }
        let mut result = encode_media_bytes(
            "video",
            &data,
            "mp4",
            format!("chat_history_{local_id}_{index}.mp4"),
        );
        result.source = Some("local-rec".into());
        return media_with_data(result);
    }
    None
}

fn is_nested_media_type(nested_type: i32) -> bool {
    matches!(
        nested_type,
        NESTED_IMAGE_TYPE
            | NESTED_VOICE_TYPE
            | NESTED_VIDEO_TYPE
            | NESTED_FILE_TYPE
            | NESTED_VOICE_MSG_TYPE
            | NESTED_VIDEO_MSG_TYPE
    )
}

fn get_chat_history_media(
    account_dir: &str,
    keys: &HashMap<String, String>,
    content: &str,
    local_id: i64,
    create_time: i64,
    image_keys_raw: Option<(String, Option<u8>)>,
) -> MediaResult {
    let image_keys = image_keys_raw.map(|(aes_key_hex, xor_byte)| ImageKeys {
        aes_key_hex,
        xor_byte,
    });
    let mut items = Vec::new();
    let mut nested_media_count = 0usize;
    for (index, item) in collect_forward_dataitems(content).into_iter().enumerate() {
        if items.len() >= MAX_NESTED_CHAT_HISTORY_MEDIA {
            break;
        }
        let nested_type = dataitem_type(&item);
        if is_nested_media_type(nested_type) {
            nested_media_count += 1;
        }
        let resolved = match nested_type {
            NESTED_IMAGE_TYPE => get_nested_image(
                account_dir,
                keys,
                &item,
                local_id,
                index,
                image_keys.as_ref(),
            ),
            NESTED_VOICE_TYPE | NESTED_VOICE_MSG_TYPE => {
                get_nested_voice(account_dir, &item, local_id, index)
            }
            NESTED_VIDEO_TYPE | NESTED_VIDEO_MSG_TYPE => {
                get_nested_video(account_dir, &item, local_id, index)
            }
            NESTED_FILE_TYPE => get_nested_file(account_dir, &item, local_id, index, create_time),
            _ => None,
        };
        if let Some(media) = resolved {
            items.push(media);
        }
    }
    // Nested media present but nothing resolved yet — Rec files are usually
    // missing until the GUI card is opened. Return retryable pending so
    // OpenClaw can fire materializeChatHistory and keep polling.
    // If some nested items already resolved (partial card), return them:
    // OpenClaw's poll treats top-level CHAT_HISTORY_NOT_MATERIALIZED as
    // forever-retryable even when `items` already carry bytes.
    if nested_media_count > 0 && items.is_empty() {
        return pending_with(
            "pending",
            "jpeg",
            format!("chat_history_{local_id}.jpg"),
            "CHAT_HISTORY_NOT_MATERIALIZED",
        );
    }
    let mut result = unsupported_without_error();
    result.items = items;
    result
}

fn quoted_media_from_xml(
    account_dir: &str,
    keys: &HashMap<String, String>,
    xml: &str,
    local_id: i64,
    create_time: i64,
    image_keys_raw: Option<(String, Option<u8>)>,
) -> Option<MediaResult> {
    if is_merged_forward_xml(xml) || is_chat_history_appmsg(0, xml) {
        return Some(get_chat_history_media(
            account_dir,
            keys,
            xml,
            local_id,
            create_time,
            image_keys_raw,
        ));
    }
    let image_keys = image_keys_raw.map(|(aes_key_hex, xor_byte)| ImageKeys {
        aes_key_hex,
        xor_byte,
    });
    if is_quoted_image_xml(xml) {
        return get_nested_image(account_dir, keys, xml, local_id, 0, image_keys.as_ref()).or_else(
            || {
                if nested_payload_md5(xml).is_none() {
                    return None;
                }
                Some(pending_with(
                    "pending",
                    "jpeg",
                    format!("quoted_{local_id}.jpg"),
                    "IMAGE_RESOURCE_UNAVAILABLE",
                ))
            },
        );
    }
    if is_quoted_file_xml(xml) {
        let mut result = get_nested_file(account_dir, xml, local_id, 0, create_time)
            .unwrap_or_else(|| {
                pending_with(
                    "file",
                    "",
                    format!("quoted_{local_id}"),
                    "FILE_NOT_DOWNLOADED",
                )
            });
        if result.data.is_some() {
            return Some(result);
        }
        result.error_code = Some("FILE_NOT_DOWNLOADED".into());
        return Some(result);
    }
    if is_quoted_voice_xml(xml) {
        return get_nested_voice(account_dir, xml, local_id, 0).or_else(|| {
            Some(pending_with(
                "pending",
                "mp3",
                format!("quoted_{local_id}.mp3"),
                "VOICE_NOT_DOWNLOADED",
            ))
        });
    }
    if is_quoted_video_xml(xml) {
        return get_nested_video(account_dir, xml, local_id, 0).or_else(|| {
            Some(pending_with(
                "pending",
                "mp4",
                format!("quoted_{local_id}.mp4"),
                "MEDIA_NOT_DOWNLOADED",
            ))
        });
    }
    None
}

// ── Public entry point ───────────────────────────────────────────────────────

/// Get media attachment for a message.
pub fn get_message_media(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    local_id: i64,
    image_keys_raw: Option<(String, Option<u8>)>,
) -> MediaResult {
    let (local_type, create_time, content) =
        match lookup_message_raw(account_dir, keys, chat_id, local_id) {
            Some(t) => t,
            None => {
                tracing::warn!("[media] lookup_message_raw returned none message_ref_present=true");
                return unsupported();
            }
        };

    let normalized = normalize_local_type(local_type);
    let base = normalized.base;
    let sub = normalized.subtype;

    match base {
        49 if sub == 6 => {
            // File attachment (appmsg subtype 6)
            return get_file_attachment(account_dir, &content, create_time, local_id);
        }
        49 if is_chat_history_appmsg(sub, &content) => {
            return get_chat_history_media(
                account_dir,
                keys,
                &content,
                local_id,
                create_time,
                image_keys_raw,
            );
        }
        49 => {
            // Quote/reply of a merged-forward card keeps the type-19 XML in refermsg.
            if let Some(referred) = refermsg_referred_xml(&content) {
                if let Some(media) = quoted_media_from_xml(
                    account_dir,
                    keys,
                    &referred,
                    local_id,
                    create_time,
                    image_keys_raw.clone(),
                ) {
                    return media;
                }
            }
            // Fall through to generic handlers below for other appmsg subtypes.
            if let Some(thumb) = get_image_thumbnail(account_dir, chat_id, local_id, create_time) {
                return thumb;
            }
            return unsupported();
        }
        3 => {
            // Image
            tracing::info!(
                "[media] image msg metadata create_time_present={} content_len={}",
                create_time != 0,
                content.len()
            );

            // Try cached thumbnail first
            if let Some(thumb) = get_image_thumbnail(account_dir, chat_id, local_id, create_time) {
                tracing::info!("[media] found thumbnail");
                let mut thumb = thumb;
                thumb.source = Some("thumbnail".into());
                return thumb;
            }
            tracing::info!("[media] no thumbnail message_ref_present=true");

            // Try .dat decryption if we have image keys
            if let Some((aes_hex, xor_byte)) = image_keys_raw {
                let image_keys = ImageKeys {
                    aes_key_hex: aes_hex,
                    xor_byte,
                };

                // Primary: look up filename from message_resource.db
                if let Some(dat_path) =
                    find_dat_via_resource_db(account_dir, keys, chat_id, local_id, create_time)
                {
                    tracing::info!("[media] found dat via resource-db path_present=true");
                    return decrypt_and_return(&dat_path, &image_keys, local_id);
                }

                // Fallback: try hardlink.db (older images may not be in resource db)
                if let Some(dat_path) = find_dat_via_hardlink(account_dir, keys, chat_id, &content)
                {
                    tracing::info!("[media] found dat via hardlink path_present=true");
                    return decrypt_and_return(&dat_path, &image_keys, local_id);
                }

                tracing::warn!(
                    "[media] no dat found md5_present={}",
                    xml_attr(&content, "md5").is_some()
                );
            } else {
                tracing::warn!("[media] no image keys available message_ref_present=true");
            }

            // Image exists but can't be retrieved
            pending_image(local_id, "IMAGE_RESOURCE_UNAVAILABLE")
        }
        43 => {
            // Video
            get_video_data(account_dir, keys, chat_id, local_id, create_time)
        }
        34 => {
            // Voice
            get_voice_data(account_dir, keys, chat_id, local_id)
        }
        47 => {
            // Emoji — CDN URL is included in message content, not a downloadable media
            unsupported()
        }
        _ => {
            // Other types: check for cached thumbnail
            if let Some(thumb) = get_image_thumbnail(account_dir, chat_id, local_id, create_time) {
                return thumb;
            }
            unsupported()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn stable_file_requires_identical_reads_across_window() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("complete.pdf");
        fs::write(&path, b"%PDF-1.7\ncomplete").unwrap();
        assert_eq!(read_stable_file(&path).unwrap(), b"%PDF-1.7\ncomplete");
    }

    #[test]
    fn stable_file_rejects_write_during_stability_window() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("growing.pdf");
        fs::write(&path, b"%PDF-1.7\ntruncated").unwrap();
        let writer_path = path.clone();
        let writer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(10));
            use std::io::Write;
            fs::OpenOptions::new()
                .append(true)
                .open(writer_path)
                .unwrap()
                .write_all(b"\ncompleted")
                .unwrap();
        });
        assert!(read_stable_file(&path).is_none());
        writer.join().unwrap();
    }

    #[test]
    fn stable_file_does_not_return_temporarily_paused_truncated_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paused.pdf");
        let truncated = b"%PDF-1.7\ntruncated";
        fs::write(&path, truncated).unwrap();
        let writer_path = path.clone();
        let writer = thread::spawn(move || {
            // The first full read sees a temporarily motionless, truncated file.
            thread::sleep(Duration::from_millis(15));
            fs::write(writer_path, b"%PDF-1.7\ncomplete document").unwrap();
        });
        assert_ne!(
            read_stable_file(&path).as_deref(),
            Some(truncated.as_slice())
        );
        writer.join().unwrap();
    }

    struct LogBuffer(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for LogBuffer {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("log buffer poisoned")
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuffer {
        type Writer = Self;

        fn make_writer(&'a self) -> Self::Writer {
            Self(Arc::clone(&self.0))
        }
    }

    fn capture_logs(run: impl FnOnce()) -> String {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(LogBuffer(Arc::clone(&buf)))
            .with_ansi(false)
            .with_level(true)
            .with_max_level(tracing::Level::TRACE)
            .finish();
        tracing::subscriber::with_default(subscriber, run);
        let bytes = buf.lock().expect("log buffer poisoned").clone();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn chat_history_appmsg_is_detected_from_packed_subtype_and_xml() {
        assert!(is_chat_history_appmsg(19, ""));
        assert!(is_chat_history_appmsg(
            0,
            "<msg><appmsg><type>19</type></appmsg></msg>"
        ));
        assert!(!is_chat_history_appmsg(
            6,
            "<msg><appmsg><type>6</type></appmsg></msg>"
        ));
    }

    #[test]
    fn quoted_chat_history_refermsg_is_treated_as_merged_forward() {
        let inner = r#"<msg><appmsg><title>Shared</title><type>19</type><recorditem><![CDATA[<recordinfo><dataitem datatype="2"><fullmd5>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</fullmd5></dataitem></recordinfo>]]></recorditem></appmsg></msg>"#;
        let escaped = inner
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;");
        let xml = format!(
            r#"<msg><appmsg><type>57</type><refermsg><content>{escaped}</content></refermsg></appmsg></msg>"#
        );
        let referred = refermsg_referred_xml(&xml).expect("referred");
        assert!(is_merged_forward_xml(&referred));
        assert!(is_chat_history_appmsg(0, &referred));
        assert_eq!(collect_forward_dataitems(&referred).len(), 1);
    }

    #[test]
    fn chat_history_media_is_unsupported_without_error_code() {
        let result = unsupported_without_error();
        assert_eq!(result.media_type, "unsupported");
        assert!(result.error_code.is_none());
        assert!(result.items.is_empty());
    }

    #[test]
    fn chat_history_with_unresolved_images_is_pending_retryable() {
        let xml = concat!(
            r#"<msg><appmsg><title>姐姐狐的聊天记录</title><type>19</type><recorditem><![CDATA["#,
            r#"<recordinfo>"#,
            r#"<dataitem datatype="2"><fullmd5>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</fullmd5></dataitem>"#,
            r#"<dataitem datatype="2"><fullmd5>bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</fullmd5></dataitem>"#,
            r#"</recordinfo>"#,
            r#"]]></recorditem></appmsg></msg>"#,
        );
        let result = get_chat_history_media(
            "/tmp/no-such-account",
            &std::collections::HashMap::new(),
            xml,
            70,
            0,
            None,
        );
        assert_eq!(result.media_type, "pending");
        assert_eq!(
            result.error_code.as_deref(),
            Some("CHAT_HISTORY_NOT_MATERIALIZED")
        );
        assert!(result.items.is_empty());
    }

    #[test]
    fn nested_dataitem_type_and_md5_are_parsed_from_record_xml() {
        let image = r#"<dataitem datatype="2"><fullmd5>ABCDEF0123456789ABCDEF0123456789</fullmd5></dataitem>"#;
        assert_eq!(dataitem_type(image), 2);
        assert_eq!(
            nested_image_md5(image).as_deref(),
            Some("abcdef0123456789abcdef0123456789")
        );
        let file = r#"<dataitem datatype="8"><datatitle>report.pdf</datatitle></dataitem>"#;
        assert_eq!(dataitem_type(file), 8);
        assert_eq!(nested_image_md5(file), None);
        let voice = r#"<dataitem datatype="3"><fullmd5>cccccccccccccccccccccccccccccccc</fullmd5></dataitem>"#;
        assert_eq!(dataitem_type(voice), 3);
        assert_eq!(
            nested_image_md5(voice).as_deref(),
            Some("cccccccccccccccccccccccccccccccc")
        );
        let video = r#"<dataitem datatype="4"><fullmd5>dddddddddddddddddddddddddddddddd</fullmd5></dataitem>"#;
        assert_eq!(dataitem_type(video), 4);
        let voice_msg_type = r#"<dataitem type="34"><datatitle>voice</datatitle></dataitem>"#;
        assert_eq!(dataitem_type(voice_msg_type), 34);
        let video_msg_type = r#"<dataitem type="43"></dataitem>"#;
        assert_eq!(dataitem_type(video_msg_type), 43);
        assert_eq!(
            nested_item_time(
                r#"<dataitem><createtime>1700000000</createtime></dataitem>"#,
                1
            ),
            1700000000
        );
    }

    fn chat_history_xml(items: &str) -> String {
        format!(
            concat!(
                r#"<msg><appmsg><title>混合记录</title><type>19</type><recorditem><![CDATA["#,
                r#"<recordinfo>{items}</recordinfo>"#,
                r#"]]></recorditem></appmsg></msg>"#,
            ),
            items = items
        )
    }

    #[test]
    fn chat_history_with_unresolved_voice_video_or_file_is_pending_retryable() {
        let xml = chat_history_xml(concat!(
            r#"<dataitem datatype="3"><fullmd5>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</fullmd5></dataitem>"#,
            r#"<dataitem datatype="4"><fullmd5>bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</fullmd5></dataitem>"#,
            r#"<dataitem datatype="8"><datatitle>参观路线.docx</datatitle></dataitem>"#,
        ));
        let result = get_chat_history_media(
            "/tmp/no-such-account",
            &std::collections::HashMap::new(),
            &xml,
            81,
            0,
            None,
        );
        assert_eq!(result.media_type, "pending");
        assert_eq!(
            result.error_code.as_deref(),
            Some("CHAT_HISTORY_NOT_MATERIALIZED")
        );
        assert!(result.items.is_empty());
    }

    #[test]
    fn chat_history_keeps_verified_items_when_other_nested_media_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"%PDF-1.7 synthetic fixture";
        let md5 = format!("{:x}", Md5::digest(data));
        let rec = dir.path().join("msg/attach/chat/2026-09/Rec/card/File");
        fs::create_dir_all(&rec).unwrap();
        fs::write(rec.join(&md5), data).unwrap();
        let xml = chat_history_xml(&format!(
            r#"<dataitem datatype="8"><datatitle>found.pdf</datatitle><fullmd5>{md5}</fullmd5></dataitem><dataitem datatype="4"><fullmd5>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</fullmd5></dataitem>"#,
        ));
        let result = get_chat_history_media(
            dir.path().to_str().unwrap(),
            &HashMap::new(),
            &xml,
            82,
            0,
            None,
        );
        // Partial success must not stay on CHAT_HISTORY_NOT_MATERIALIZED:
        // OpenClaw retries that code forever even when `items` already have bytes.
        assert_eq!(result.error_code.as_deref(), None);
        assert_ne!(result.media_type, "pending");
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].filename, "chat_history_82_0_found.pdf");
        assert_eq!(
            result.items[0].data.as_deref(),
            Some(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, data).as_str())
        );
    }

    #[test]
    fn nested_file_requires_full_digest_not_basename_dataid_or_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let files = dir.path().join("msg/file/1970-01");
        fs::create_dir_all(&files).unwrap();
        fs::write(files.join("same.pdf"), b"unrelated cached file").unwrap();
        let account = dir.path().to_str().unwrap();
        let data = b"%PDF-1.7 expected";
        let md5 = format!("{:x}", Md5::digest(data));
        let item = format!(
            r#"<dataitem datatype="8"><datatitle>same.pdf</datatitle><fullmd5>{md5}</fullmd5></dataitem>"#
        );
        assert!(get_nested_file(account, &item, 7, 0, 0).is_none());
        fs::write(files.join("same.pdf"), data).unwrap();
        assert!(get_nested_file(account, &item, 7, 0, 0).is_some());
        assert!(get_nested_file(account, &item.replace("fullmd5", "thumbfullmd5"), 7, 0, 0).is_none());
        assert!(get_nested_file(
            account,
            &format!(r#"<dataitem dataid="{md5}"><datatitle>same.pdf</datatitle></dataitem>"#),
            7,
            0,
            0
        )
        .is_none());
    }

    #[test]
    fn thumbnail_attributes_are_not_full_payload_hashes() {
        let item = r#"<dataitem thumbfullmd5="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" />"#;
        assert!(nested_payload_md5(item).is_none());
        assert_eq!(nested_image_md5(item).as_deref(), Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    }

    #[test]
    fn rec_lookup_rejects_prefix_files_and_video_covers() {
        let dir = tempfile::tempdir().unwrap();
        let rec = dir.path().join("msg/attach/chat/2026-09/Rec/card/Video");
        fs::create_dir_all(&rec).unwrap();
        let data = b"\xff\xd8\xffcover";
        let md5 = format!("{:x}", Md5::digest(data));
        fs::write(rec.join(format!("{md5}.jpg")), data).unwrap();
        fs::write(rec.join(format!("{md5}-other.mp4")), data).unwrap();
        assert!(find_rec_named_file(dir.path(), "Video", &md5).is_none());
        fs::write(rec.join(format!("{md5}.mp4")), data).unwrap();
        let item = format!("<fullmd5>{md5}</fullmd5>");
        assert!(get_nested_video(dir.path().to_str().unwrap(), &item, 7, 0).is_none());
        let video = b"\x00\x00\x00\x18ftypisomfixture";
        let hash = format!("{:x}", Md5::digest(video));
        fs::write(rec.join(format!("{hash}.mp4")), video).unwrap();
        assert!(get_nested_video(
            dir.path().to_str().unwrap(),
            &format!("<fullmd5>{hash}</fullmd5>"),
            7,
            0
        )
        .is_some());
    }

    #[test]
    fn rec_numeric_image_names_must_not_choose_first_card() {
        let dir = tempfile::tempdir().unwrap();
        for card in ["first", "second"] {
            let img = dir
                .path()
                .join(format!("msg/attach/chat/2026-09/Rec/{card}/Img"));
            fs::create_dir_all(&img).unwrap();
            fs::write(img.join("0"), card).unwrap();
        }
        assert!(resolve_hardlink_dat_path(dir.path(), "chat", "2026-09", "0", None).is_none());
    }

    #[test]
    fn dat_thumbnail_names_include_rec_bare_suffix() {
        assert!(is_dat_thumbnail_name("abc_t.dat"));
        assert!(is_dat_thumbnail_name("0_t"));
        assert!(is_dat_thumbnail_name("12_t"));
        assert!(!is_dat_thumbnail_name("0"));
        assert!(!is_dat_thumbnail_name("0.dat"));
        assert!(!is_dat_thumbnail_name("photo.jpg"));
    }

    #[test]
    fn rec_numeric_image_names_disambiguate_by_hardlink_file_size() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir
            .path()
            .join("msg/attach/chat/2026-09/Rec/first/Img");
        let second = dir
            .path()
            .join("msg/attach/chat/2026-09/Rec/second/Img");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        // Simulate ciphertext framing: on-disk len = logical file_size + 31.
        fs::write(first.join("0"), vec![0u8; 100 + 31]).unwrap();
        fs::write(second.join("0"), vec![1u8; 200 + 31]).unwrap();
        let found = resolve_hardlink_dat_path(dir.path(), "chat", "2026-09", "0", Some(200)).unwrap();
        assert!(found.ends_with("second/Img/0"));
        let found = resolve_hardlink_dat_path(dir.path(), "chat", "2026-09", "0", Some(100)).unwrap();
        assert!(found.ends_with("first/Img/0"));
        assert!(resolve_hardlink_dat_path(dir.path(), "chat", "2026-09", "0", Some(999)).is_none());
    }

    #[test]
    fn rec_named_file_rejects_same_stem_in_two_cards() {
        let dir = tempfile::tempdir().unwrap();
        let stem = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        for card in ["card-a", "card-b"] {
            let voic = dir
                .path()
                .join(format!("msg/attach/chat/2026-09/Rec/{card}/Voic"));
            fs::create_dir_all(&voic).unwrap();
            fs::write(voic.join(stem), b"\x02#!SILK_V3").unwrap();
        }
        assert!(find_rec_named_file(dir.path(), "Voic", stem).is_none());
    }

    #[test]
    fn md5_filename_lookup_rejects_thumbnails_and_duplicate_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let md5 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let img = dir.path().join("msg/attach/chat/2026-09/Img");
        fs::create_dir_all(&img).unwrap();
        fs::write(img.join(format!("{md5}_t.dat")), b"thumb").unwrap();
        assert!(find_dat_via_md5_filename(dir.path().to_str().unwrap(), md5).is_none());
        fs::write(img.join(format!("{md5}.dat")), b"full").unwrap();
        let found = find_dat_via_md5_filename(dir.path().to_str().unwrap(), md5).unwrap();
        assert!(found.ends_with(&format!("{md5}.dat")));

        let other = dir.path().join("msg/attach/other/2026-09/Img");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join(format!("{md5}.dat")), b"other").unwrap();
        assert!(find_dat_via_md5_filename(dir.path().to_str().unwrap(), md5).is_none());
    }

    #[test]
    fn nested_image_requires_full_payload_hash_not_thumbnail() {
        let item = r#"<dataitem datatype="2" thumbfullmd5="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" />"#;
        assert!(nested_payload_md5(item).is_none());
        assert!(get_nested_image(
            "/tmp/no-such-account",
            &HashMap::new(),
            item,
            7,
            0,
            None
        )
        .is_none());
    }

    #[test]
    fn thumbnail_lookup_requires_exact_local_id_and_create_time() {
        let dir = tempfile::tempdir().unwrap();
        let chat_id = "wxid_direct";
        let hash = format!("{:x}", Md5::digest(chat_id.as_bytes()));
        let thumb_dir = dir
            .path()
            .join("cache/1970-01/Message")
            .join(&hash)
            .join("Thumb");
        fs::create_dir_all(&thumb_dir).unwrap();
        fs::write(thumb_dir.join("7_1_thumb.jpg"), b"\xff\xd8\xffold").unwrap();
        fs::write(thumb_dir.join("70_0_thumb.jpg"), b"\xff\xd8\xffprefix").unwrap();
        assert!(get_image_thumbnail(dir.path().to_str().unwrap(), chat_id, 7, 0).is_none());
        fs::write(thumb_dir.join("7_0_thumb.jpg"), b"\xff\xd8\xffexact").unwrap();
        let found = get_image_thumbnail(dir.path().to_str().unwrap(), chat_id, 7, 0).unwrap();
        assert_eq!(
            found.data.as_deref(),
            Some(
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\xff\xd8\xffexact")
                    .as_str()
            )
        );
    }

    #[test]
    fn find_rec_named_file_scans_voic_and_video_folders() {
        let dir = tempfile::tempdir().unwrap();
        let month = dir.path().join("msg/attach").join("chat").join("2026-09");
        let voic = month.join("Rec").join("id").join("Voic");
        let video = month.join("Rec").join("id").join("Video");
        fs::create_dir_all(&voic).unwrap();
        fs::create_dir_all(&video).unwrap();
        fs::write(
            voic.join("cccccccccccccccccccccccccccccccc"),
            b"\x02#!SILK_V3",
        )
        .unwrap();
        fs::write(video.join("dddddddddddddddddddddddddddddddd.mp4"), b"mp4").unwrap();
        let found_voice =
            find_rec_named_file(dir.path(), "Voic", "cccccccccccccccccccccccccccccccc").unwrap();
        assert_eq!(found_voice, voic.join("cccccccccccccccccccccccccccccccc"));
        let found_video =
            find_rec_named_file(dir.path(), "Video", "dddddddddddddddddddddddddddddddd").unwrap();
        assert_eq!(
            found_video,
            video.join("dddddddddddddddddddddddddddddddd.mp4")
        );
    }

    #[test]
    fn quoted_image_xml_exposes_md5_for_local_lookup() {
        let referred = r#"<msg><img md5="ABCDEF0123456789ABCDEF0123456789" /></msg>"#;
        assert_eq!(
            nested_image_md5(referred).as_deref(),
            Some("abcdef0123456789abcdef0123456789")
        );
        assert!(is_quoted_image_xml(referred));
        assert!(!is_quoted_image_xml(
            r#"<msg><appmsg><type>6</type><title>a.pdf</title></appmsg></msg>"#
        ));
        assert!(is_quoted_file_xml(
            r#"<msg><appmsg><type>6</type><title>a.pdf</title></appmsg></msg>"#
        ));
        assert!(is_quoted_voice_xml(
            r#"<msg><voicemsg voicelength="1200" /></msg>"#
        ));
        assert!(is_quoted_video_xml(
            r#"<msg><videomsg md5="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" /></msg>"#
        ));
    }

    #[test]
    fn resolve_hardlink_dat_path_finds_ordinary_img_with_and_without_dat_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let img = base
            .join("msg/attach")
            .join("chat_md5")
            .join("2026-09")
            .join("Img");
        fs::create_dir_all(&img).unwrap();
        fs::write(img.join("abc.dat"), b"ordinary").unwrap();
        let found = resolve_hardlink_dat_path(base, "chat_md5", "2026-09", "abc", None).unwrap();
        assert_eq!(found, img.join("abc.dat"));

        fs::write(img.join("bare"), b"bare-img").unwrap();
        let found_bare = resolve_hardlink_dat_path(base, "chat_md5", "2026-09", "bare", None).unwrap();
        assert_eq!(found_bare, img.join("bare"));
    }

    #[test]
    fn resolve_hardlink_dat_path_falls_back_to_rec_img_when_ordinary_img_missing() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let rec_img = base
            .join("msg/attach")
            .join("chat_md5")
            .join("2026-09")
            .join("Rec")
            .join("nested_card_id")
            .join("Img");
        fs::create_dir_all(&rec_img).unwrap();
        // Nested 聊天记录 images are often bare indices with no .dat suffix.
        fs::write(rec_img.join("0"), b"rec0").unwrap();
        fs::write(rec_img.join("1"), b"rec1").unwrap();

        let found0 = resolve_hardlink_dat_path(base, "chat_md5", "2026-09", "0", None).unwrap();
        assert_eq!(found0, rec_img.join("0"));
        let found1 = resolve_hardlink_dat_path(base, "chat_md5", "2026-09", "1", None).unwrap();
        assert_eq!(found1, rec_img.join("1"));
        assert!(resolve_hardlink_dat_path(base, "chat_md5", "2026-09", "2", None).is_none());
    }

    #[test]
    fn resolve_hardlink_dat_path_prefers_ordinary_img_over_rec() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let month = base.join("msg/attach").join("chat_md5").join("2026-09");
        let img = month.join("Img");
        let rec_img = month.join("Rec").join("id").join("Img");
        fs::create_dir_all(&img).unwrap();
        fs::create_dir_all(&rec_img).unwrap();
        fs::write(img.join("0"), b"ordinary").unwrap();
        fs::write(rec_img.join("0"), b"rec").unwrap();
        let found = resolve_hardlink_dat_path(base, "chat_md5", "2026-09", "0", None).unwrap();
        assert_eq!(found, img.join("0"));
    }

    #[test]
    fn generic_unsupported_media_still_sets_error_code() {
        assert_eq!(
            unsupported().error_code.as_deref(),
            Some("MEDIA_UNSUPPORTED")
        );
    }

    #[test]
    fn inbound_filenames_preserve_unicode_but_remove_paths() {
        assert_eq!(
            sanitize_inbound_filename("报告 2026.pdf", 7),
            "报告 2026.pdf"
        );
        assert_eq!(sanitize_inbound_filename("../../秘密.pdf", 7), "秘密.pdf");
        assert_eq!(
            sanitize_inbound_filename(r"..\\..\\计划.pdf", 7),
            "计划.pdf"
        );
        assert_eq!(sanitize_inbound_filename("...", 7), "file_7");
        assert!(sanitize_inbound_filename(&"界".repeat(200), 7).len() <= 240);
    }

    #[test]
    fn hostile_media_failure_logs_are_redacted() {
        let mut keys = HashMap::new();
        keys.insert(
            "hardlink.db".to_string(),
            "hostile-secret-hardlink-key".to_string(),
        );
        keys.insert(
            "message_resource.db".to_string(),
            "hostile-secret-resource-key".to_string(),
        );
        keys.insert(
            "message_0.db".to_string(),
            "hostile-secret-message-key".to_string(),
        );

        let account_dir = "hostile-account/Users/kyan/private/xwechat_files";
        let chat_id = "wxid_sensitive_chat@chatroom";
        let local_id = 987654321_i64;
        let xml_md5 = "0123456789abcdef0123456789abcdef";
        let file_hash = "fedcba9876543210fedcba9876543210";
        let filename = "private-family-photo.dat";
        let cdn_url = "https://cdn.example.invalid/path/private-family-photo.jpg?token=secret";
        let content = format!(
            r#"<msg><img md5="{xml_md5}" aeskey="secret-aes-key" cdnmidimgurl="{cdn_url}" cdnbigimgurl="{cdn_url}" filehash="{file_hash}" filename="{filename}"/></msg>"#
        );

        let logs = capture_logs(|| {
            let _ = find_dat_via_hardlink(account_dir, &keys, chat_id, &content);
            let _ = find_dat_via_resource_db(account_dir, &keys, chat_id, local_id, 1_760_000_000);
            let _ = get_message_media(
                account_dir,
                &keys,
                chat_id,
                local_id,
                Some(("00112233445566778899aabbccddeeff".to_string(), Some(0x42))),
            );
        });

        assert!(
            logs.contains("[media"),
            "expected media diagnostics in logs: {logs}"
        );
        for forbidden in [
            account_dir,
            "/Users/kyan/private",
            "xwechat_files",
            chat_id,
            &local_id.to_string(),
            xml_md5,
            file_hash,
            filename,
            cdn_url,
            "cdnmidimgurl",
            "cdnbigimgurl",
            "secret-aes-key",
            "hostile-secret-hardlink-key",
            "hostile-secret-resource-key",
            "hostile-secret-message-key",
        ] {
            assert!(
                !logs.contains(forbidden),
                "leaked {forbidden} in logs: {logs}"
            );
        }
    }
}
