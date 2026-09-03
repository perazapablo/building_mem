//! FTS5 query construction.
//!
//! Splits on whitespace, strips embedded double quotes, wraps each term in
//! quotes and joins with ` AND ` so every term must match. Previously joined
//! with `OR`, which turned any multi-term query into an almost-query-all
//! (a hit on any single term was enough). Returns `None` when the result
//! would be empty so callers can short-circuit.

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
        Some(terms.join(" AND "))
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
    fn multiple_terms_joined_with_and() {
        assert_eq!(
            to_fts_query("foo bar baz").as_deref(),
            Some("\"foo\" AND \"bar\" AND \"baz\"")
        );
    }

    #[test]
    fn embedded_quotes_stripped() {
        assert_eq!(
            to_fts_query("a\"b c").as_deref(),
            Some("\"ab\" AND \"c\"")
        );
    }
}
