fn main() {
    println!("cargo:rerun-if-env-changed=PROVENANCE_SANDBOX_IMAGE");
    println!("cargo:rerun-if-env-changed=PROVENANCE_PACKAGED_RELEASE");
    if let Ok(marker) = std::env::var("PROVENANCE_PACKAGED_RELEASE") {
        if marker != "1" {
            panic!("PROVENANCE_PACKAGED_RELEASE must be exactly 1 when set");
        }
        println!("cargo:rustc-env=PROVENANCE_PACKAGED_RELEASE=1");
    }
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
