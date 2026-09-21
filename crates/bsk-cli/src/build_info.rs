//! Compile-time build identity.
//!
//! The app version alone cannot tell two builds apart, and the failure that
//! causes is one of the worst to debug: a daemon left running from an older
//! build answers a newer CLI with a reply it cannot parse, while
//! `bsk --version` and the daemon's reported version agree on both sides. The
//! git revision is what makes "the CLI and the daemon are different builds"
//! a checkable fact rather than an inference from a confusing error.
//!
//! `BSK_GIT_SHA` is written by `build.rs`; see there for the fallbacks.

/// App version, from `Cargo.toml`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Short git revision this binary was built from, or `"unknown"`.
pub const GIT_SHA: &str = env!("BSK_GIT_SHA");

/// `VERSION (GIT_SHA)` — the form shown to users.
pub fn describe() -> String {
    format!("{VERSION} ({GIT_SHA})")
}

/// Whether this build came from a git checkout.
///
/// Used to keep `bsk update` honest: a local build is newer or older than a
/// release by definition, so reporting it as "up to date" is misleading.
pub fn is_local_build() -> bool {
    GIT_SHA != "unknown"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_carries_both_halves() {
        let described = describe();
        assert!(described.contains(VERSION), "{described}");
        assert!(described.contains(GIT_SHA), "{described}");
    }

    #[test]
    fn the_sha_is_short_enough_to_read_in_a_status_line() {
        // A full 40-char sha in every `--version` / `doctor` line is noise; the
        // point is to tell two builds apart, not to be a stable identifier.
        assert!(
            GIT_SHA == "unknown" || GIT_SHA.len() <= 12,
            "expected a short revision, got {GIT_SHA:?}"
        );
    }
}
