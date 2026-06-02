use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub fn normalize_stable_text(input: &str) -> String {
    let nfd: String = input.nfd().collect();
    let stripped: String = nfd
        .chars()
        .filter(|c| !matches!(*c as u32, 0x0300..=0x036F))
        .collect();
    let lower = stripped.trim().to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut last_space = false;
    for c in lower.chars() {
        if c.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

pub fn hash_normalized(input: &str) -> String {
    let normalized = normalize_stable_text(input);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn normalize_topic_key(key: Option<&str>) -> Option<String> {
    let key = key?;
    let base = normalize_stable_text(key);
    let mut out = String::with_capacity(base.len());
    let mut last_dash = false;
    for c in base.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.len() > 120 {
        out.truncate(120);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub fn note_hash_source(content: &str) -> String {
    content.to_string()
}

pub fn decision_hash_source(decision: &str, reasoning: &str) -> String {
    format!("{}\n{}", decision, reasoning)
}

pub fn artifact_hash_source(ty: &str, content: &str) -> String {
    format!("{}\n{}", ty, content)
}

pub fn code_entity_hash_source(
    kind: &str,
    name: &str,
    qualified_name: &str,
    path: &str,
    signature: &str,
    summary: &str,
) -> String {
    let qn = if qualified_name.is_empty() { name } else { qualified_name };
    [kind, qn, path, signature, summary].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_diacritics_and_lowercases() {
        assert_eq!(normalize_stable_text("  Árbol  Vé "), "arbol ve");
    }

    #[test]
    fn topic_key_kebab() {
        assert_eq!(
            normalize_topic_key(Some("billing.xml.parseInvoiceXml")).as_deref(),
            Some("billing-xml-parseinvoicexml")
        );
    }

    #[test]
    fn hash_is_deterministic_after_normalization() {
        assert_eq!(hash_normalized("Hola"), hash_normalized("  HOLA  "));
    }
}
