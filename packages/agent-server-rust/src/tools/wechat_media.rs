use crate::ia::types::MediaResult;
use crate::tools::wechat_db::{get_db_path, query_wechat_db};
use crate::tools::wechat_message_type::normalize_local_type;
use crate::tools::wechat_messages::{decode_message_content, extract_xml_tag, find_message_db, get_msg_table_name};
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
    }
}

fn unsupported() -> MediaResult {
    let mut result = media_result("unsupported", None, "", "");
    result.error_code = Some("MEDIA_UNSUPPORTED".into());
    result
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
    pending_with(
        "pending",
        "jpeg",
        format!("msg_{local_id}.jpg"),
        code,
    )
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

fn account_base_paths(account_dir: &str) -> [String; 2] {
    [
        format!("/home/wechat/xwechat_files/{account_dir}"),
        format!("/home/wechat/Documents/xwechat_files/{account_dir}"),
    ]
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
    let start = xml.find(&pat)? + pat.len();
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
                });
            }
        }

        // Fallback: find any thumbnail matching this localId
        let thumb_dir = Path::new(base)
            .join("cache")
            .join(&year_month)
            .join("Message")
            .join(&hash)
            .join("Thumb");
        if let Ok(entries) = fs::read_dir(&thumb_dir) {
            let prefix = format!("{local_id}_");
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&prefix) {
                    if let Some(data) = read_stable_file(&entry.path()) {
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
                        });
                    }
                }
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
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
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

fn resolve_xor_byte(
    dat_path: &str,
    dat: &[u8],
    image_keys: &ImageKeys,
) -> Option<u8> {
    if let Some(xb) = image_keys.xor_byte {
        return Some(xb);
    }
    let (dec_head, _) = decrypt_dat_head(dat, &image_keys.aes_key_hex)?;
    let xb = derive_xor_byte(dat, &dec_head);
    if xb.is_some() {
        return xb;
    }
    // Try sibling _t.dat files (JPEG thumbnails are reliable for XOR derivation)
    let dir = Path::new(dat_path).parent()?;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with("_t.dat") {
                continue;
            }
            if let Some(sib) = read_stable_file(&entry.path()) {
                if sib.len() < 15 || sib[..6] != DAT_MAGIC {
                    continue;
                }
                if let Some((sib_head, _)) =
                    decrypt_dat_head(&sib, &image_keys.aes_key_hex)
                {
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
            tracing::warn!("[media:hardlink] no md5 attr in content (len={})", content.len());
            return None;
        }
    };
    let hardlink_db = get_db_path(account_dir, "hardlink.db");

    let file_rows = query_wechat_db(
        &hardlink_db,
        hardlink_key,
        &format!(
            "SELECT file_name, dir1, dir2 FROM image_hardlink_info_v4
             WHERE md5 = '{image_md5}' LIMIT 2;"
        ),
    );
    let row = match file_rows.first() {
        Some(r) => r,
        None => {
            tracing::warn!("[media:hardlink] no hardlink row md5_present=true");
            return None;
        }
    };
    let file_name = row.get("file_name")?.as_str()?;
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
        let dat_path = Path::new(base)
            .join("msg/attach")
            .join(chat_dir)
            .join(date_dir)
            .join("Img")
            .join(file_name);
        if dat_path.exists() {
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
            if candidate.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)) {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

fn decrypt_and_return(
    dat_path: &str,
    image_keys: &ImageKeys,
    local_id: i64,
) -> MediaResult {
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
            };
        }
        // Try _t.dat thumbnail
        let thumb_path = dat_path.replace(".dat", "_t.dat");
        if Path::new(&thumb_path).exists() {
            if let Some(thumb_dat) = read_stable_file(Path::new(&thumb_path)) {
                if let Some(xb2) = resolve_xor_byte(&thumb_path, &thumb_dat, image_keys) {
                    if let Some(dec) =
                        decrypt_dat(&thumb_dat, &image_keys.aes_key_hex, xb2)
                    {
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
            &format!(
                "SELECT cdn_url FROM kNonStoreEmoticonTable WHERE md5 = '{md5_val}' LIMIT 1;"
            ),
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
        let hex_data = match voice_rows
            .first()
            .and_then(|r| r.get("hex_data")?.as_str())
        {
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
        };
    }

    pending_with("voice", "", format!("msg_{local_id}"), "VOICE_NOT_DOWNLOADED")
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
        3 => {
            // Image
            tracing::info!(
                "[media] image msg metadata create_time_present={} content_len={}",
                create_time != 0,
                content.len()
            );

            // Try cached thumbnail first
            if let Some(thumb) =
                get_image_thumbnail(account_dir, chat_id, local_id, create_time)
            {
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
                if let Some(dat_path) = find_dat_via_resource_db(
                    account_dir, keys, chat_id, local_id, create_time,
                ) {
                    tracing::info!("[media] found dat via resource-db path_present=true");
                    return decrypt_and_return(&dat_path, &image_keys, local_id);
                }

                // Fallback: try hardlink.db (older images may not be in resource db)
                if let Some(dat_path) = find_dat_via_hardlink(account_dir, keys, chat_id, &content) {
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
            if let Some(thumb) =
                get_image_thumbnail(account_dir, chat_id, local_id, create_time)
            {
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
        assert_ne!(read_stable_file(&path).as_deref(), Some(truncated.as_slice()));
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
        keys.insert("hardlink.db".to_string(), "hostile-secret-hardlink-key".to_string());
        keys.insert(
            "message_resource.db".to_string(),
            "hostile-secret-resource-key".to_string(),
        );
        keys.insert("message_0.db".to_string(), "hostile-secret-message-key".to_string());

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

        assert!(logs.contains("[media"), "expected media diagnostics in logs: {logs}");
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
            assert!(!logs.contains(forbidden), "leaked {forbidden} in logs: {logs}");
        }
    }
}
