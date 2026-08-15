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
    fn cursors_are_versioned_and_kind_bound() {
        let cursor = encode("messages:chat", (10_i64, 4_i64)).unwrap();
        assert_eq!(decode::<(i64, i64)>("messages:chat", &cursor).unwrap(), (10, 4));
        assert_eq!(decode::<(i64, i64)>("messages:other", &cursor), Err("INVALID_CURSOR"));
        assert_eq!(decode::<(i64, i64)>("messages:chat", "../bad"), Err("INVALID_CURSOR"));
    }
}
