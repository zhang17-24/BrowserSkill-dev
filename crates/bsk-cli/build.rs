//! Build-time work for the `bsk` binary:
//!
//! 1. Keep the packaged `skill/SKILL.md` in sync with the repo-root skill
//!    during dev builds.
//! 2. Stamp the git revision in, so a binary can say *which build* it is and
//!    not just which version number it carries.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    sync_skill_md();
    stamp_build_sha();
}

/// Write `BSK_GIT_SHA` for `env!("BSK_GIT_SHA")` to read.
///
/// A version number is not a build identity: `cargo build` of the same
/// `Cargo.toml` version produces a binary that is *not* interchangeable with
/// the last one, and the failure that causes is nasty — a daemon started from
/// an older build answers a newer CLI with an `Method` variant it has never
/// heard of, and every version string on both sides still matches. Recording
/// the revision turns that into a one-line diagnosis.
///
/// Falls back to `BSK_BUILD_SHA` for builds without a `.git` directory (a
/// packaged source tarball, a release pipeline that passes it in), and to
/// `"unknown"` so the binary always has something to report.
fn stamp_build_sha() {
    println!("cargo:rustc-env=BSK_GIT_SHA={}", git_sha());
    // `HEAD` is a file when the branch is checked out directly and a symref
    // otherwise, so watch both it and the refs directory. Cargo has no
    // recursive `rerun-if-changed`, so the directory is the practical choice.
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs");
}

fn git_sha() -> String {
    if let Ok(injected) = env::var("BSK_BUILD_SHA")
        && !injected.trim().is_empty()
    {
        return injected.trim().to_string();
    }

    let repo = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("../..");
    Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(repo)
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn sync_skill_md() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let src = manifest.join("../../skill/SKILL.md");
    let dst = manifest.join("skill/SKILL.md");

    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed=build.rs");

    if !src.is_file() {
        // `cargo package` on crates.io ships `skill/SKILL.md` committed in-tree.
        return;
    }

    // The repo-root skill may be a symlink to the packaged skill.
    // Avoid copying a file onto itself through the symlink.
    if let (Ok(src_real), Ok(dst_real)) = (src.canonicalize(), dst.canonicalize()) {
        if src_real == dst_real {
            return;
        }
    }

    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).expect("create skill/ directory");
    }
    fs::copy(&src, &dst).expect("sync skill/SKILL.md from repo root");
}
