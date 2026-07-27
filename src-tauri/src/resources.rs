use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

const RESOURCE_MANIFEST_BYTES: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/runtime-resource-manifest.json"));
const RESOURCE_MANIFEST_SHA256: &str = env!("PROVENANCE_RESOURCE_MANIFEST_SHA256");
const RESOURCE_MANIFEST_KIND: &str = "provenance.runtime-resource-manifest";
pub const DEVELOPMENT_RESOURCE_MANIFEST_SENTINEL: &str = "unverified-development";
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_RESOURCE_FILES: usize = 4096;
const MAX_RESOURCE_BYTES: u64 = 256 * 1024 * 1024;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT_VALUE: u32 = 0x400;

#[derive(Debug, Error)]
pub enum ResourceError {
    #[error("the packaged runtime has no authenticated build-time resource manifest")]
    MissingManifest,
    #[error("the embedded runtime resource manifest is invalid")]
    InvalidManifest,
    #[error("runtime resource {0} failed exact authentication")]
    InvalidResource(String),
    #[error("the runtime resource root is invalid")]
    InvalidRoot,
    #[error("runtime resource I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceManifest {
    schema_version: u8,
    kind: String,
    resources: Vec<ResourceRecord>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceRecord {
    path: String,
    sha256: String,
    size: u64,
}

pub struct ResourceLease {
    manifest_sha256: String,
    _files: Vec<File>,
    published_manifest: Option<PublishedManifest>,
}

struct PublishedManifest {
    path: PathBuf,
    file: Option<File>,
}

impl Drop for PublishedManifest {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.path);
    }
}

impl ResourceLease {
    pub fn authenticate(
        resource_root: &Path,
        packaged_release: bool,
    ) -> Result<Self, ResourceError> {
        if RESOURCE_MANIFEST_SHA256 == DEVELOPMENT_RESOURCE_MANIFEST_SENTINEL {
            if packaged_release || RESOURCE_MANIFEST_BYTES != b"unverified-development\n" {
                return Err(ResourceError::MissingManifest);
            }
            return Ok(Self {
                manifest_sha256: DEVELOPMENT_RESOURCE_MANIFEST_SENTINEL.to_owned(),
                _files: Vec::new(),
                published_manifest: None,
            });
        }
        if !packaged_release
            || RESOURCE_MANIFEST_BYTES.is_empty()
            || RESOURCE_MANIFEST_BYTES.len() > MAX_MANIFEST_BYTES
            || !is_sha256(RESOURCE_MANIFEST_SHA256)
            || hex::encode(Sha256::digest(RESOURCE_MANIFEST_BYTES)) != RESOURCE_MANIFEST_SHA256
        {
            return Err(ResourceError::InvalidManifest);
        }
        let manifest: ResourceManifest = serde_json::from_slice(RESOURCE_MANIFEST_BYTES)
            .map_err(|_| ResourceError::InvalidManifest)?;
        validate_manifest(&manifest)?;
        let root = canonical_directory_without_reparse(resource_root)?;
        authenticate_exact_dist_tree(&root, &manifest.resources)?;
        let mut files = Vec::with_capacity(manifest.resources.len());
        for resource in &manifest.resources {
            files.push(authenticate_resource(&root, resource)?);
        }
        Ok(Self {
            manifest_sha256: RESOURCE_MANIFEST_SHA256.to_owned(),
            _files: files,
            published_manifest: None,
        })
    }

    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }

    pub fn publish_authenticated_manifest(
        &mut self,
        runtime_directory: &Path,
        launch_id: &str,
    ) -> Result<Option<PathBuf>, ResourceError> {
        if self.manifest_sha256 == DEVELOPMENT_RESOURCE_MANIFEST_SENTINEL {
            return Ok(None);
        }
        if self.published_manifest.is_some()
            || launch_id.len() != 32
            || !launch_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ResourceError::InvalidManifest);
        }
        let runtime_directory = canonical_directory_without_reparse(runtime_directory)?;
        let path = runtime_directory.join(format!(".desktop-resource-manifest-{launch_id}.json"));
        if path.parent() != Some(runtime_directory.as_path()) || path.exists() {
            return Err(ResourceError::InvalidManifest);
        }
        let write_result = (|| -> Result<(), ResourceError> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            file.write_all(RESOURCE_MANIFEST_BYTES)?;
            file.sync_all()?;
            drop(file);
            let mut file = open_read_locked(&path)?;
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.len() != RESOURCE_MANIFEST_BYTES.len() as u64 {
                return Err(ResourceError::InvalidManifest);
            }
            let mut bytes = Vec::with_capacity(RESOURCE_MANIFEST_BYTES.len());
            file.read_to_end(&mut bytes)?;
            if bytes != RESOURCE_MANIFEST_BYTES {
                return Err(ResourceError::InvalidManifest);
            }
            self.published_manifest = Some(PublishedManifest {
                path: path.clone(),
                file: Some(file),
            });
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        Ok(Some(path))
    }
}

fn authenticate_exact_dist_tree(
    root: &Path,
    resources: &[ResourceRecord],
) -> Result<(), ResourceError> {
    let expected_files = resources
        .iter()
        .filter(|resource| resource.path.starts_with("dist/"))
        .map(|resource| resource.path.clone())
        .collect::<BTreeSet<_>>();
    if !expected_files.contains("dist/server.cjs")
        || !expected_files.contains("dist/index.html")
        || !expected_files
            .iter()
            .any(|resource| resource.starts_with("dist/assets/"))
    {
        return Err(ResourceError::InvalidManifest);
    }
    let mut expected_directories = BTreeSet::from(["dist".to_owned()]);
    for file in &expected_files {
        let segments = file.split('/').collect::<Vec<_>>();
        for end in 1..segments.len() {
            expected_directories.insert(segments[..end].join("/"));
        }
    }

    let dist = root.join("dist");
    let metadata = std::fs::symlink_metadata(&dist)
        .map_err(|_| ResourceError::InvalidResource("dist".into()))?;
    if !metadata.is_dir() || metadata_has_reparse_point(&metadata) {
        return Err(ResourceError::InvalidResource("dist".into()));
    }
    let mut actual_files = BTreeSet::new();
    let mut actual_directories = BTreeSet::from(["dist".to_owned()]);
    let mut pending = vec![(dist, "dist".to_owned())];
    while let Some((directory, relative_directory)) = pending.pop() {
        let entries = std::fs::read_dir(&directory)
            .map_err(|_| ResourceError::InvalidResource(relative_directory.clone()))?;
        for entry in entries {
            let entry =
                entry.map_err(|_| ResourceError::InvalidResource(relative_directory.clone()))?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| ResourceError::InvalidResource(relative_directory.clone()))?;
            let relative = format!("{relative_directory}/{name}");
            if !is_canonical_resource_path(&relative) {
                return Err(ResourceError::InvalidResource(relative));
            }
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|_| ResourceError::InvalidResource(relative.clone()))?;
            if metadata_has_reparse_point(&metadata) {
                return Err(ResourceError::InvalidResource(relative));
            }
            if metadata.is_dir() {
                actual_directories.insert(relative.clone());
                pending.push((entry.path(), relative));
            } else if metadata.is_file() {
                actual_files.insert(relative);
            } else {
                return Err(ResourceError::InvalidResource(relative));
            }
            if actual_files.len() + actual_directories.len() > MAX_RESOURCE_FILES * 2 {
                return Err(ResourceError::InvalidResource("dist".into()));
            }
        }
    }
    if actual_files != expected_files || actual_directories != expected_directories {
        return Err(ResourceError::InvalidResource("dist".into()));
    }
    Ok(())
}

fn validate_manifest(manifest: &ResourceManifest) -> Result<(), ResourceError> {
    if manifest.schema_version != 1
        || manifest.kind != RESOURCE_MANIFEST_KIND
        || manifest.resources.is_empty()
        || manifest.resources.len() > MAX_RESOURCE_FILES
    {
        return Err(ResourceError::InvalidManifest);
    }
    let mut previous = "";
    for resource in &manifest.resources {
        if !is_canonical_resource_path(&resource.path)
            || resource.path.as_str() <= previous
            || !is_sha256(&resource.sha256)
            || resource.size == 0
            || resource.size > MAX_RESOURCE_BYTES
        {
            return Err(ResourceError::InvalidManifest);
        }
        previous = &resource.path;
    }
    Ok(())
}

fn authenticate_resource(root: &Path, resource: &ResourceRecord) -> Result<File, ResourceError> {
    let relative = resource
        .path
        .split('/')
        .fold(PathBuf::new(), |path, segment| path.join(segment));
    let candidate = root.join(relative);
    validate_path_components_without_reparse(root, &candidate, &resource.path)?;
    let mut file = open_read_locked(&candidate)
        .map_err(|_| ResourceError::InvalidResource(resource.path.clone()))?;
    let metadata = file
        .metadata()
        .map_err(|_| ResourceError::InvalidResource(resource.path.clone()))?;
    if !metadata.is_file() || metadata.len() != resource.size {
        return Err(ResourceError::InvalidResource(resource.path.clone()));
    }
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| ResourceError::InvalidResource(resource.path.clone()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| ResourceError::InvalidResource(resource.path.clone()))?;
        if total > resource.size {
            return Err(ResourceError::InvalidResource(resource.path.clone()));
        }
        hasher.update(&buffer[..read]);
    }
    if total != resource.size || hex::encode(hasher.finalize()) != resource.sha256 {
        return Err(ResourceError::InvalidResource(resource.path.clone()));
    }
    Ok(file)
}

fn canonical_directory_without_reparse(path: &Path) -> Result<PathBuf, ResourceError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| ResourceError::InvalidRoot)?;
    if !metadata.is_dir() || metadata_has_reparse_point(&metadata) {
        return Err(ResourceError::InvalidRoot);
    }
    std::fs::canonicalize(path).map_err(|_| ResourceError::InvalidRoot)
}

fn validate_path_components_without_reparse(
    root: &Path,
    candidate: &Path,
    label: &str,
) -> Result<(), ResourceError> {
    let relative = candidate
        .strip_prefix(root)
        .map_err(|_| ResourceError::InvalidResource(label.to_owned()))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|_| ResourceError::InvalidResource(label.to_owned()))?;
        if metadata_has_reparse_point(&metadata) {
            return Err(ResourceError::InvalidResource(label.to_owned()));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_has_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0
}

#[cfg(not(windows))]
fn metadata_has_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn open_read_locked(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::FILE_SHARE_READ;
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0)
        .open(path)
}

#[cfg(not(windows))]
fn open_read_locked(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_canonical_resource_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.contains('\0')
        && value.split('/').all(|segment| {
            !segment.is_empty()
                && !matches!(segment, "." | "..")
                && segment.bytes().enumerate().all(|(index, byte)| {
                    byte.is_ascii_alphanumeric()
                        || (index > 0 && matches!(byte, b'.' | b'_' | b'@' | b'+' | b'-'))
                })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_build_has_an_explicit_unverified_sentinel() {
        if option_env!("PROVENANCE_PACKAGED_RELEASE").is_none() {
            let lease = ResourceLease::authenticate(Path::new("."), false).unwrap();
            assert_eq!(
                lease.manifest_sha256(),
                DEVELOPMENT_RESOURCE_MANIFEST_SENTINEL
            );
            assert!(ResourceLease::authenticate(Path::new("."), true).is_err());
        }
    }

    #[test]
    fn resource_paths_reject_escape_and_noncanonical_segments() {
        assert!(is_canonical_resource_path("dist/assets/index.js"));
        assert!(!is_canonical_resource_path("../server.cjs"));
        assert!(!is_canonical_resource_path("dist//server.cjs"));
        assert!(!is_canonical_resource_path("dist\\server.cjs"));
    }

    #[test]
    fn packaged_dist_inventory_rejects_unlisted_files() {
        let root = std::env::temp_dir().join(format!(
            "provenance-resource-inventory-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(root.join("dist/assets")).unwrap();
        for relative in ["dist/server.cjs", "dist/index.html", "dist/assets/app.js"] {
            std::fs::write(root.join(relative), b"signed").unwrap();
        }
        let resources = ["dist/assets/app.js", "dist/index.html", "dist/server.cjs"]
            .into_iter()
            .map(|resource| ResourceRecord {
                path: resource.to_owned(),
                sha256: "a".repeat(64),
                size: 6,
            })
            .collect::<Vec<_>>();
        assert!(authenticate_exact_dist_tree(&root, &resources).is_ok());
        std::fs::write(root.join("dist/server.cjs.map"), b"unlisted").unwrap();
        assert!(authenticate_exact_dist_tree(&root, &resources).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
