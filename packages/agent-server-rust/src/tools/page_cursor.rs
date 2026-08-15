use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{de::DeserializeOwned, Serialize};

const CURSOR_VERSION: u8 = 1;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct Envelope<T> {
    version: u8,
    kind: String,
    value: T,
}

pub fn encode<T: Serialize>(kind: &str, value: T) -> Result<String, &'static str> {
    let bytes = serde_json::to_vec(&Envelope {
        version: CURSOR_VERSION,
        kind: kind.to_string(),
        value,
    })
    .map_err(|_| "CURSOR_ENCODE_FAILED")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn lookahead_query_limit(requested: i64, public_max: i64) -> i64 {
    requested.clamp(1, public_max + 1)
}

pub fn truncate_lookahead<T>(items: &mut Vec<T>, public_limit: i64) -> bool {
    let has_more = items.len() > public_limit as usize;
    items.truncate(public_limit as usize);
    has_more
}

pub fn decode<T: DeserializeOwned>(kind: &str, raw: &str) -> Result<T, &'static str> {
    if raw.is_empty() || raw.len() > 1024 || !raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("INVALID_CURSOR");
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| "INVALID_CURSOR")?;
    let envelope: Envelope<T> = serde_json::from_slice(&bytes).map_err(|_| "INVALID_CURSOR")?;
    if envelope.version != CURSOR_VERSION || envelope.kind != kind {
        return Err("INVALID_CURSOR");
    }
    Ok(envelope.value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookahead_limits_retain_the_boundary_row() {
        assert_eq!(lookahead_query_limit(101, 100), 101);
        assert_eq!(lookahead_query_limit(201, 200), 201);
        assert_eq!(lookahead_query_limit(999, 200), 201);
        let mut chats = (0..101).collect::<Vec<_>>();
        assert!(truncate_lookahead(&mut chats, 100));
        assert_eq!(chats.len(), 100);
        let mut messages = (0..201).collect::<Vec<_>>();
        assert!(truncate_lookahead(&mut messages, 200));
        assert_eq!(messages.len(), 200);
    }

    #[test]
    fn cursors_are_versioned_and_kind_bound() {
        let cursor = encode("messages:chat", (10_i64, 4_i64)).unwrap();
        assert_eq!(decode::<(i64, i64)>("messages:chat", &cursor).unwrap(), (10, 4));
        assert_eq!(decode::<(i64, i64)>("messages:other", &cursor), Err("INVALID_CURSOR"));
        assert_eq!(decode::<(i64, i64)>("messages:chat", "../bad"), Err("INVALID_CURSOR"));
    }
}
