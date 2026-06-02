//! FTS5 query construction.
//!
//! Mirrors `toFtsQuery` in `src/db.ts` L156: splits on whitespace, strips
//! embedded double quotes, wraps each term in quotes and joins with ` OR `.
//! Returns `None` when the result would be empty so callers can short-circuit
//! (TS returns "" — Rust prefers the explicit option).

pub fn to_fts_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.replace('"', ""))
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" OR "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_returns_none() {
        assert!(to_fts_query("").is_none());
        assert!(to_fts_query("   ").is_none());
        assert!(to_fts_query("\"\"").is_none());
        assert!(to_fts_query("\"\"\"\"").is_none());
    }

    #[test]
    fn single_term_quoted() {
        assert_eq!(to_fts_query("hello").as_deref(), Some("\"hello\""));
    }

    #[test]
    fn multiple_terms_joined_with_or() {
        assert_eq!(
            to_fts_query("foo bar baz").as_deref(),
            Some("\"foo\" OR \"bar\" OR \"baz\"")
        );
    }

    #[test]
    fn embedded_quotes_stripped() {
        assert_eq!(
            to_fts_query("a\"b c").as_deref(),
            Some("\"ab\" OR \"c\"")
        );
    }
}
