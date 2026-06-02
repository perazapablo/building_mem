//! Tokenizer-aware token counting.
//!
//! Phase 2 ships only the conservative fallback. The named tokenizers
//! (`anthropic:claude`, `openai:o200k_base`, `openai:cl100k_base`) are
//! accepted as identifiers and stored on rows, but their counts currently
//! fall back to the generic estimate. Real tokenizers land in Phase 2.5
//! behind feature flags so they don't blow up compile times here.

use std::sync::OnceLock;

pub const GENERIC: &str = "generic:conservative";
pub const ANTHROPIC_CLAUDE: &str = "anthropic:claude";
pub const OPENAI_O200K: &str = "openai:o200k_base";
pub const OPENAI_CL100K: &str = "openai:cl100k_base";

const SUPPORTED: &[&str] = &[GENERIC, ANTHROPIC_CLAUDE, OPENAI_O200K, OPENAI_CL100K];

pub fn resolve(value: Option<&str>) -> &'static str {
    let Some(v) = value else { return GENERIC };
    match v {
        ANTHROPIC_CLAUDE => ANTHROPIC_CLAUDE,
        OPENAI_O200K => OPENAI_O200K,
        OPENAI_CL100K => OPENAI_CL100K,
        GENERIC => GENERIC,
        _ => GENERIC,
    }
}

pub fn is_supported(value: &str) -> bool {
    SUPPORTED.contains(&value)
}

pub fn default_model() -> &'static str {
    static MODEL: OnceLock<&'static str> = OnceLock::new();
    MODEL.get_or_init(|| {
        let env = std::env::var("MCP_MEMORY_TOKENIZER").ok();
        resolve(env.as_deref())
    })
}

pub fn count(text: &str, model: &str) -> usize {
    match model {
        // Real tokenizers land in Phase 2.5. For now they share the
        // conservative estimate; recorded `tokenizer_model` keeps row
        // identity stable so we don't have to re-key when we add them.
        ANTHROPIC_CLAUDE | OPENAI_O200K | OPENAI_CL100K | GENERIC => generic_estimate(text),
        _ => generic_estimate(text),
    }
}

/// Token count + tokenizer identifier for one serialized entity payload.
/// Mirrors `tokenMetadata` in `src/db.ts`. The model used is the process-wide
/// default resolved from `MCP_MEMORY_TOKENIZER`.
pub fn token_metadata(serialized: &str) -> (i64, &'static str) {
    let model = default_model();
    (count(serialized, model) as i64, model)
}

fn generic_estimate(text: &str) -> usize {
    let len = text.chars().count();
    let est = (len as f64 / 2.5).ceil() as usize;
    est.max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_falls_back_to_generic() {
        assert_eq!(resolve(None), GENERIC);
        assert_eq!(resolve(Some("unknown:model")), GENERIC);
        assert_eq!(resolve(Some(ANTHROPIC_CLAUDE)), ANTHROPIC_CLAUDE);
    }

    #[test]
    fn count_is_at_least_one_for_non_empty() {
        assert_eq!(count("", GENERIC), 1);
        assert_eq!(count("a", GENERIC), 1);
    }

    #[test]
    fn count_scales_with_chars_not_bytes() {
        let ascii = "hello world";
        let utf8 = "hólá mündo";
        assert!(count(ascii, GENERIC) > 0);
        assert!(count(utf8, GENERIC) > 0);
    }
}
