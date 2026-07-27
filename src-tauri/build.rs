use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

const RESOURCE_MANIFEST_PATH_ENV: &str = "PROVENANCE_RESOURCE_MANIFEST_PATH";
const RESOURCE_MANIFEST_SHA256_ENV: &str = "PROVENANCE_RESOURCE_MANIFEST_SHA256";
const RESOURCE_MANIFEST_KIND: &str = "provenance.runtime-resource-manifest";
const RESOURCE_MANIFEST_OUTPUT: &str = "runtime-resource-manifest.json";
const DEVELOPMENT_SENTINEL: &[u8] = b"unverified-development\n";
const DEVELOPMENT_SENTINEL_LABEL: &str = "unverified-development";
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_RESOURCE_FILES: usize = 4096;
const MAX_RESOURCE_BYTES: u64 = 256 * 1024 * 1024;

fn main() {
    println!("cargo:rerun-if-env-changed=PROVENANCE_SANDBOX_IMAGE");
    println!("cargo:rerun-if-env-changed=PROVENANCE_PACKAGED_RELEASE");
    println!("cargo:rerun-if-env-changed={RESOURCE_MANIFEST_PATH_ENV}");
    println!("cargo:rerun-if-env-changed={RESOURCE_MANIFEST_SHA256_ENV}");
    let packaged = if let Ok(marker) = std::env::var("PROVENANCE_PACKAGED_RELEASE") {
        if marker != "1" {
            panic!("PROVENANCE_PACKAGED_RELEASE must be exactly 1 when set");
        }
        println!("cargo:rustc-env=PROVENANCE_PACKAGED_RELEASE=1");
        true
    } else {
        false
    };
    prepare_resource_manifest(packaged);
    if let Ok(image) = std::env::var("PROVENANCE_SANDBOX_IMAGE") {
        if !is_digest_pinned_image(&image) {
            panic!(
                "PROVENANCE_SANDBOX_IMAGE must be registry/repository@sha256:<64 lowercase hex>"
            );
        }
        println!("cargo:rustc-env=PROVENANCE_SANDBOX_IMAGE={image}");
    }
    tauri_build::build();
}

fn prepare_resource_manifest(packaged: bool) {
    let configured_path = std::env::var_os(RESOURCE_MANIFEST_PATH_ENV);
    let configured_digest = std::env::var(RESOURCE_MANIFEST_SHA256_ENV).ok();
    if !packaged {
        if configured_path.is_some() || configured_digest.is_some() {
            panic!("development builds must use the explicit unverified resource sentinel");
        }
        write_embedded_manifest(DEVELOPMENT_SENTINEL, DEVELOPMENT_SENTINEL_LABEL);
        return;
    }

    let configured_path =
        configured_path.unwrap_or_else(|| panic!("{RESOURCE_MANIFEST_PATH_ENV} is required"));
    let expected_digest =
        configured_digest.unwrap_or_else(|| panic!("{RESOURCE_MANIFEST_SHA256_ENV} is required"));
    if !is_sha256(&expected_digest) {
        panic!("{RESOURCE_MANIFEST_SHA256_ENV} must be an exact lowercase SHA-256 digest");
    }
    let path = PathBuf::from(configured_path);
    println!("cargo:rerun-if-changed={}", path.display());
    let metadata = std::fs::symlink_metadata(&path)
        .unwrap_or_else(|_| panic!("the runtime resource manifest is unreadable"));
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > MAX_MANIFEST_BYTES as u64
    {
        panic!("the runtime resource manifest must be a bounded regular file");
    }
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|_| panic!("the runtime resource manifest is unreadable"));
    validate_resource_manifest(&bytes);
    let actual_digest = hex::encode(Sha256::digest(&bytes));
    if actual_digest != expected_digest {
        panic!("the runtime resource manifest does not match its independently supplied digest");
    }
    write_embedded_manifest(&bytes, &actual_digest);
}

fn write_embedded_manifest(bytes: &[u8], digest: &str) {
    let output = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is required"))
        .join(RESOURCE_MANIFEST_OUTPUT);
    std::fs::write(output, bytes).expect("the embedded runtime resource manifest must be writable");
    println!("cargo:rustc-env=PROVENANCE_RESOURCE_MANIFEST_SHA256={digest}");
}

fn validate_resource_manifest(bytes: &[u8]) {
    let value: Value =
        serde_json::from_slice(bytes).expect("the runtime resource manifest must be valid JSON");
    let object = value
        .as_object()
        .expect("the runtime resource manifest must be an object");
    let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
    keys.sort_unstable();
    if keys != ["kind", "resources", "schemaVersion"] {
        panic!("the runtime resource manifest has an unexpected schema");
    }
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || object.get("kind").and_then(Value::as_str) != Some(RESOURCE_MANIFEST_KIND)
    {
        panic!("the runtime resource manifest identity is invalid");
    }
    let resources = object
        .get("resources")
        .and_then(Value::as_array)
        .expect("the runtime resource manifest resources must be an array");
    if resources.is_empty() || resources.len() > MAX_RESOURCE_FILES {
        panic!("the runtime resource manifest must contain a bounded resource list");
    }
    let mut previous = "";
    for resource in resources {
        let resource = resource
            .as_object()
            .expect("runtime resource entries must be objects");
        let mut keys = resource.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        if keys != ["path", "sha256", "size"] {
            panic!("a runtime resource entry has an unexpected schema");
        }
        let path = resource
            .get("path")
            .and_then(Value::as_str)
            .expect("a runtime resource path is missing");
        let digest = resource
            .get("sha256")
            .and_then(Value::as_str)
            .expect("a runtime resource digest is missing");
        let size = resource
            .get("size")
            .and_then(Value::as_u64)
            .expect("a runtime resource size is missing");
        if !is_canonical_resource_path(path)
            || path <= previous
            || !is_sha256(digest)
            || size == 0
            || size > MAX_RESOURCE_BYTES
        {
            panic!("a runtime resource entry is invalid or unsorted");
        }
        previous = path;
    }
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

fn is_digest_pinned_image(value: &str) -> bool {
    let Some((repository, digest)) = value.rsplit_once("@sha256:") else {
        return false;
    };
    repository.contains('/')
        && !repository.starts_with('/')
        && !repository.ends_with('/')
        && repository.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b'-' | b'/' | b':')
        })
        && digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
