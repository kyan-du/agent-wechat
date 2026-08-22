/// Normalize WeChat's packed 64-bit `local_type` value.
/// The low 32 bits contain the message type (with a direction flag in bit 31)
/// and the high 32 bits contain the app-message subtype.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalMessageType {
    pub base: i32,
    pub subtype: i32,
}

pub fn normalize_local_type(local_type: i64) -> LocalMessageType {
    LocalMessageType {
        base: ((local_type as u64 & 0x7fff_ffff) as u32) as i32,
        subtype: ((local_type as u64 >> 32) as u32) as i32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_packed_64_bit_group_image_fixture() {
        let packed = ((7_i64) << 32) | 0x8000_0003_u32 as i64;
        assert_eq!(
            normalize_local_type(packed),
            LocalMessageType {
                base: 3,
                subtype: 7
            }
        );
    }
}
