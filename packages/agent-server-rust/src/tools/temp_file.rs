use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Creates owned temporary artifacts under a dedicated, non-shared directory.
#[derive(Debug)]
pub struct OwnedTempFile {
    path: PathBuf,
}

impl OwnedTempFile {
    pub fn create(prefix: &str, extension: &str) -> std::io::Result<Self> {
        let dir = std::env::var_os("AGENT_WECHAT_TEMP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("agent-wechat"));
        std::fs::create_dir_all(&dir)?;
        let safe_prefix: String = prefix.chars().filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-').take(32).collect();
        let safe_extension: String = extension.chars().filter(|ch| ch.is_ascii_alphanumeric()).take(12).collect();
        let path = dir.join(format!("{safe_prefix}-{}.{safe_extension}", Uuid::new_v4()));
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path { &self.path }

    pub fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        std::fs::write(&self.path, bytes)
    }
}

impl Drop for OwnedTempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_temp_file_is_scoped_and_removed_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("AGENT_WECHAT_TEMP_DIR", dir.path());
        let path = {
            let file = OwnedTempFile::create("send file", "pdf").unwrap();
            file.write(b"test").unwrap();
            assert!(file.path().starts_with(dir.path()));
            assert!(file.path().exists());
            file.path().to_path_buf()
        };
        assert!(!path.exists());
        std::env::remove_var("AGENT_WECHAT_TEMP_DIR");
    }
}
