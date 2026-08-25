use std::fs::{create_dir_all, metadata, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug)]
pub struct OwnedTempFile {
    path: PathBuf,
    cleaned: bool,
}

impl OwnedTempFile {
    pub fn create(prefix: &str, extension: &str) -> std::io::Result<Self> {
        let dir = std::env::var_os("AGENT_WECHAT_TEMP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("agent-wechat"));
        validate_temp_root(&dir)?;
        create_dir_all(&dir)?;
        let safe_prefix: String = prefix.chars().filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-').take(32).collect();
        let safe_extension: String = extension.chars().filter(|ch| ch.is_ascii_alphanumeric()).take(12).collect();
        for _ in 0..3 {
            let path = dir.join(format!("{safe_prefix}-{}.{safe_extension}", Uuid::new_v4()));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(Self { path, cleaned: false }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "temporary file collision"))
    }

    pub fn path(&self) -> &Path { &self.path }

    pub fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        let metadata = metadata(&self.path)?;
        if !metadata.file_type().is_file() { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "temporary path is not a regular file")); }
        let mut file = OpenOptions::new().write(true).truncate(true).open(&self.path)?;
        file.write_all(bytes)
    }

    pub fn cleanup(&mut self) -> std::io::Result<()> {
        if self.cleaned { return Ok(()); }
        let metadata = metadata(&self.path)?;
        if !metadata.file_type().is_file() { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "temporary path is not a regular file")); }
        std::fs::remove_file(&self.path)?;
        self.cleaned = true;
        Ok(())
    }
}

impl Drop for OwnedTempFile {
    fn drop(&mut self) { let _ = self.cleanup(); }
}

fn validate_temp_root(root: &Path) -> std::io::Result<()> {
    if !root.is_absolute() { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "temporary root must be absolute")); }
    if root.components().any(|component| component == std::path::Component::ParentDir) { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "temporary root contains traversal")); }
    if root.exists() && root.symlink_metadata()?.file_type().is_symlink() { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "temporary root is a symlink")); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_temp_file_is_exclusive_and_removed_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("AGENT_WECHAT_TEMP_DIR", dir.path());
        let path = {
            let mut file = OwnedTempFile::create("send file", "pdf").unwrap();
            file.write(b"test").unwrap();
            assert!(file.path().starts_with(dir.path()));
            assert!(file.path().exists());
            file.cleanup().unwrap();
            file.path().to_path_buf()
        };
        assert!(!path.exists());
        std::env::remove_var("AGENT_WECHAT_TEMP_DIR");
    }

    #[test]
    fn relative_or_symlink_temp_roots_fail_closed() {
        let relative = PathBuf::from("relative-temp");
        assert!(validate_temp_root(&relative).is_err());
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("link");
        #[cfg(unix)] std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        #[cfg(unix)] assert!(validate_temp_root(&link).is_err());
    }
}
