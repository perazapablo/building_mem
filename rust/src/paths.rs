//! Home directory resolution, without external dependencies.
//!
//! Exists so no file in the crate has to spell out an absolute path. The repo
//! is cloned the same way on Windows and Linux; a `C:/Users/<user>` compiled
//! in forces the installer to rewrite it with `sed`, which makes portability a
//! property of the installer rather than of the code.
//!
//! The `dirs` crate is deliberately not used: two environment variables cover
//! both systems we care about, and a new dependency does not pay for itself
//! over six lines.

use std::env;
use std::path::PathBuf;

/// The user's home. `HOME` on Unix, `USERPROFILE` on Windows.
///
/// Returns `None` when neither is set — a real case in services and some
/// containers. The caller decides what to do with that; no default is invented
/// here, because a wrong default writes files to a silently incorrect place.
pub fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// `home_dir()` joined with the given segments. `None` if there is no home.
///
/// ```ignore
/// under_home(&[".config", "agent-rules"]);  // ~/.config/agent-rules
/// ```
pub fn under_home(segments: &[&str]) -> Option<PathBuf> {
    let mut p = home_dir()?;
    for s in segments {
        p.push(s);
    }
    Some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_home_appends_segments() {
        let Some(home) = home_dir() else { return };
        let got = under_home(&[".config", "x"]).unwrap();
        assert_eq!(got, home.join(".config").join("x"));
    }

    #[test]
    fn under_home_with_no_segments_is_home() {
        let Some(home) = home_dir() else { return };
        assert_eq!(under_home(&[]).unwrap(), home);
    }
}
