//! Classify WeChat UI popups that mean "stop sending".

use crate::ia::types::PopupState;

const SECURITY_PATTERNS: &[&str] = &[
    "环境异常",
    "账号安全",
    "帐号安全",
    "功能限制",
    "需要验证",
    "安全验证",
    "解封",
    "投诉",
    "操作频繁",
    "频繁",
    "异常登录",
    "登录环境",
    "unusual",
    "restricted",
    "security verification",
    "verify your",
    "too frequent",
];

pub fn is_security_text(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    SECURITY_PATTERNS.iter().any(|p| {
        if p.is_ascii() {
            lower.contains(p)
        } else {
            text.contains(p)
        }
    })
}

pub fn is_security_popup(popup: &PopupState) -> bool {
    popup
        .message
        .as_deref()
        .map(is_security_text)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ia::types::PopupType;

    #[test]
    fn flags_chinese_security_copy() {
        assert!(is_security_text("当前登录环境异常，为了你的帐号安全"));
        assert!(is_security_text("操作过于频繁，请稍后再试"));
        assert!(is_security_text("请完成安全验证"));
    }

    #[test]
    fn ignores_ordinary_errors() {
        assert!(!is_security_text("Network timeout"));
        assert!(!is_security_text("发送失败"));
        assert!(!is_security_text("Tip"));
    }

    #[test]
    fn popup_wrapper_reads_message() {
        let popup = PopupState {
            popup_type: PopupType::Error,
            message: Some("功能限制".into()),
        };
        assert!(is_security_popup(&popup));
    }
}
