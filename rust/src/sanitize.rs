//! Defensa contra contaminación de inputs con XML de tool calls.
//!
//! Cuando un modelo confunde su propia sintaxis de tool call con contenido
//! de string, termina insertando fragmentos como `<invoke name="add_decision">…`
//! o `<parameter name="reasoning">…</parameter>` dentro del payload real.
//! Ejemplo real: thread `dd5c7836` en project mcp_memory quedó con XML crudo
//! mezclado. Este módulo lo strippea antes de persistir.
//!
//! Reglas:
//! - Bloques emparejados (`<invoke …>…</invoke>`, `<parameter …>…</parameter>`,
//!   `<function_calls>…</function_calls>`): se remueven completos, contenido
//!   incluido.
//! - `<parameter name="X">…</X>`: el modelo a veces cierra con `</X>` en vez de
//!   `</parameter>`. Se detecta el atributo `name` y se cierra por ese tag
//!   también.
//! - Cierres huérfanos: además de `</invoke>`, `</parameter>`,
//!   `</function_calls>`, se strippea cualquier `</snake_case>` remanente
//!   (contaminación típica de tool-call XML: `</decision>`, `</reasoning>`,
//!   `</topic_key>`, etc.). Trade-off: rompe texto que contenga literales
//!   `</word>` en snake_case ASCII, aceptable para campos de decisión/nota.
//! - Sufijo trailing `</thread>` (caso observado): se remueve.
//! - Whitespace externo se colapsa con `trim`.
//!
//! No es case-insensitive: los modelos escriben tags en minúsculas. Trade-off
//! aceptado a cambio de simplicidad.

const BLOCK_TAGS: &[(&str, &str)] = &[
    ("<function_calls>", "</function_calls>"),
    ("<invoke", "</invoke>"),
];

const ORPHAN_CLOSERS: &[&str] = &[
    "</function_calls>",
    "</invoke>",
    "</parameter>",
];

/// Elimina fragmentos de tool call XML del input. Determinista, idempotente.
pub fn strip_tool_call_tags(input: &str) -> String {
    let mut s = input.to_string();

    for (open, close) in BLOCK_TAGS {
        s = strip_block(&s, open, close);
    }
    s = strip_parameter_blocks(&s);
    for closer in ORPHAN_CLOSERS {
        s = s.replace(closer, "");
    }
    s = strip_snake_case_orphan_closers(&s);

    // Sufijo `</thread>` (caso observado en thread 9cb3905f).
    let trimmed = s.trim_end();
    if let Some(without) = trimmed.strip_suffix("</thread>") {
        s = without.to_string();
    }

    s.trim().to_string()
}

/// `<parameter name="X" …>…</parameter>` o `<parameter name="X" …>…</X>`.
/// Si no hay cierre válido, remueve solo la apertura y preserva el contenido.
fn strip_parameter_blocks(s: &str) -> String {
    const OPEN: &str = "<parameter";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        let after_open_prefix = &rest[start..];

        let (gt_idx, name_attr) = match after_open_prefix.find('>') {
            Some(gt) => (gt, extract_name_attr(&after_open_prefix[..gt])),
            None => {
                out.push_str(after_open_prefix);
                rest = "";
                break;
            }
        };
        let after_open_end = &after_open_prefix[gt_idx + 1..];

        // Candidatos de cierre: `</parameter>` y `</NAME>` si name existe.
        let mut best: Option<(usize, usize)> = None; // (idx, close_len)
        if let Some(idx) = after_open_end.find("</parameter>") {
            best = Some((idx, "</parameter>".len()));
        }
        if let Some(name) = name_attr {
            let close = format!("</{name}>");
            if let Some(idx) = after_open_end.find(&close) {
                match best {
                    Some((prev, _)) if prev <= idx => {}
                    _ => best = Some((idx, close.len())),
                }
            }
        }

        match best {
            Some((end, close_len)) => {
                rest = &after_open_end[end + close_len..];
            }
            None => {
                rest = after_open_end;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Extrae el valor de `name="X"` del interior de un tag (sin `<` ni `>`).
/// Solo comillas dobles, minúsculas snake_case + guiones + dígitos.
fn extract_name_attr(inner: &str) -> Option<&str> {
    let key = "name=\"";
    let start = inner.find(key)? + key.len();
    let tail = &inner[start..];
    let end = tail.find('"')?;
    let value = &tail[..end];
    if value.is_empty() || !value.chars().all(is_name_char) {
        return None;
    }
    Some(value)
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'
}

/// Strippea cualquier `</snake_case>` remanente. Los modelos generan cierres
/// con nombre custom (`</decision>`, `</reasoning>`, `</topic_key>`) cuando
/// confunden su propia sintaxis. Solo aplica a ASCII lowercase snake — evita
/// tocar HTML normal (`</div>` sí caería, aceptamos: no es texto esperable
/// en campos de decisión/nota).
fn strip_snake_case_orphan_closers(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            let name_start = i + 2;
            let mut j = name_start;
            while j < bytes.len() && is_name_byte(bytes[j]) {
                j += 1;
            }
            if j > name_start && j < bytes.len() && bytes[j] == b'>' {
                i = j + 1;
                continue;
            }
        }
        // Push single char (UTF-8 safe via char boundary).
        let ch_end = next_char_boundary(s, i);
        out.push_str(&s[i..ch_end]);
        i = ch_end;
    }
    out
}

fn is_name_byte(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-'
}

fn next_char_boundary(s: &str, i: usize) -> usize {
    let mut j = i + 1;
    while j < s.len() && !s.is_char_boundary(j) {
        j += 1;
    }
    j
}

/// Remueve todos los bloques `<open…>…<close>` (open puede tener atributos).
/// Si un `<open` no tiene cierre, remueve solo el tag de apertura y conserva
/// el contenido siguiente — evita perder texto útil cuando el modelo cierra
/// mal el XML pero deja mensaje intencional después.
fn strip_block(s: &str, open_prefix: &str, close: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find(open_prefix) {
        out.push_str(&rest[..start]);
        let after_open_prefix = &rest[start..];

        // Buscar el `>` de la apertura. Si no está, no es tag válido —
        // dejar pasar el texto sin cambio.
        let after_open_end = match after_open_prefix.find('>') {
            Some(gt) => &after_open_prefix[gt + 1..],
            None => {
                out.push_str(after_open_prefix);
                rest = "";
                break;
            }
        };

        match after_open_end.find(close) {
            Some(end) => {
                rest = &after_open_end[end + close.len()..];
            }
            None => {
                // Sin cierre: consumir el tag de apertura, seguir con el resto.
                rest = after_open_end;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_through_clean_text() {
        assert_eq!(strip_tool_call_tags("hello world"), "hello world");
        assert_eq!(strip_tool_call_tags(""), "");
        assert_eq!(strip_tool_call_tags("  padded  "), "padded");
    }

    #[test]
    fn strips_invoke_block() {
        let input = "before<invoke name=\"add_decision\">stuff</invoke>after";
        assert_eq!(strip_tool_call_tags(input), "beforeafter");
    }

    #[test]
    fn strips_parameter_block() {
        let input = "pre<parameter name=\"reasoning\">why</parameter>post";
        assert_eq!(strip_tool_call_tags(input), "prepost");
    }

    #[test]
    fn strips_function_calls_block() {
        let input = "<function_calls>anything here</function_calls>tail";
        assert_eq!(strip_tool_call_tags(input), "tail");
    }

    #[test]
    fn strips_orphan_closers() {
        let input = "content</invoke>more</parameter>end";
        assert_eq!(strip_tool_call_tags(input), "contentmoreend");
    }

    #[test]
    fn strips_trailing_thread_close() {
        let input = "real thread content\n</thread>";
        assert_eq!(strip_tool_call_tags(input), "real thread content");
    }

    #[test]
    fn strips_trailing_thread_then_invoke() {
        // Caso real observado en thread 9cb3905f:
        // "...decir cuál es realmente la sesión viva.</thread>\n</invoke>"
        let input = "texto util</thread>\n</invoke>";
        assert_eq!(strip_tool_call_tags(input), "texto util");
    }

    #[test]
    fn strips_nested_parameters_inside_invoke() {
        let input = "\
            <invoke name=\"add_decision\">\
            <parameter name=\"project_id\">abc</parameter>\
            <parameter name=\"decision\">real content</parameter>\
            </invoke>\
        ";
        // Estrategia actual: primero remueve <function_calls>, luego <invoke
        // …</invoke> (incluye lo anidado). Nada queda.
        assert_eq!(strip_tool_call_tags(input), "");
    }

    #[test]
    fn strips_dd5c7836_style_contamination() {
        // Contenido real observado: add_decision (MCP)(...) con XML incrustado
        // seguido de instrucción en mayúsculas.
        let input = "add_decision (MCP)(project_id: \"abc\", decision: \"foo</parameter>\n<parameter name=\"reasoning\">porque X</parameter>\n<parameter name=\"importance\">3\") CORREGIR Y VALIDAR";
        let out = strip_tool_call_tags(input);
        assert!(!out.contains("<parameter"), "quedaron tags: {out}");
        assert!(!out.contains("</parameter>"), "quedaron cierres: {out}");
        assert!(out.contains("CORREGIR Y VALIDAR"), "se perdió texto útil: {out}");
    }

    #[test]
    fn strips_unclosed_open_tag_keeps_content() {
        // Modelo abrió tag pero olvidó cerrarlo — perder el texto útil sería
        // peor que dejar contenido sin envolver.
        let input = "keep this <invoke name=\"foo\">unclosed content";
        assert_eq!(strip_tool_call_tags(input), "keep this unclosed content");
    }

    #[test]
    fn strips_parameter_with_name_matched_closer() {
        // Modelo cierra con `</reasoning>` en vez de `</parameter>`.
        let input = "pre<parameter name=\"reasoning\">why</reasoning>post";
        assert_eq!(strip_tool_call_tags(input), "prepost");
    }

    #[test]
    fn strips_snake_case_orphan_closers() {
        // Caso real: decision termina con </decision> y siguen params con
        // closers custom `</reasoning>`, `</topic_key>`.
        let input = "Sidebar soporta 3 niveles.</decision>\n<parameter name=\"reasoning\">Pablo pidió X</reasoning>\n<parameter name=\"topic_key\">nav-3-niveles</topic_key>\n<parameter name=\"importance\">7";
        let out = strip_tool_call_tags(input);
        assert!(!out.contains("</decision>"), "quedó </decision>: {out}");
        assert!(!out.contains("</reasoning>"), "quedó </reasoning>: {out}");
        assert!(!out.contains("</topic_key>"), "quedó </topic_key>: {out}");
        assert!(!out.contains("<parameter"), "quedó <parameter: {out}");
        assert!(out.starts_with("Sidebar soporta 3 niveles."), "se perdió inicio: {out}");
    }

    #[test]
    fn preserves_utf8_content() {
        let input = "decisión con acento é y ñ.</decision>";
        assert_eq!(strip_tool_call_tags(input), "decisión con acento é y ñ.");
    }

    #[test]
    fn is_idempotent() {
        let dirty = "<invoke name=\"x\">a</invoke>b</parameter>";
        let once = strip_tool_call_tags(dirty);
        let twice = strip_tool_call_tags(&once);
        assert_eq!(once, twice);
    }
}
