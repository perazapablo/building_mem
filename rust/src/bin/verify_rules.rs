//! agent-rules verify
//!
//! Cross-checks coherence between agent-rules/{catalog, profiles, skills}/,
//! Claude Code settings.json hooks, and opencode.json instructions[].
//!
//! Usage:
//!     verify-rules [--root <path>] [--claude-settings <path>] [--opencode-config <path>] [--quiet]
//!
//! Defaults (relativos al home del usuario):
//!     --root              ~/.config/agent-rules
//!     --claude-settings   ~/.claude/settings.json
//!     --opencode-config   ~/.config/opencode/opencode.json
//!
//! Exit codes:
//!     0 — ok
//!     1 — warnings only
//!     2 — failures present

use anyhow::{anyhow, Context, Result};
use mcp_memory::paths;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Args {
    root: PathBuf,
    claude_settings: PathBuf,
    opencode_config: PathBuf,
    quiet: bool,
}

/// The explicit path if the caller gave one, otherwise the convention under $HOME.
///
/// Errors instead of guessing when there is no home: a wrong default makes
/// verify report "missing" for files that do exist, sending the user to look
/// for the problem in the wrong place.
fn resolve(explicit: Option<PathBuf>, under: &[&str]) -> Result<PathBuf> {
    if let Some(p) = explicit {
        return Ok(p);
    }
    paths::under_home(under).ok_or_else(|| {
        anyhow!(
            "cannot resolve home (HOME/USERPROFILE unset): pass an explicit path for ~/{}",
            under.join("/")
        )
    })
}

fn parse_args() -> Result<Args> {
    let mut root: Option<PathBuf> = env::var_os("AGENT_RULES_ROOT").map(PathBuf::from);
    let mut claude_settings: Option<PathBuf> = None;
    let mut opencode_config: Option<PathBuf> = None;
    let mut quiet = false;

    let mut it = env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--root" => root = Some(PathBuf::from(it.next().ok_or_else(|| anyhow!("--root requiere valor"))?)),
            "--claude-settings" => claude_settings = Some(PathBuf::from(it.next().ok_or_else(|| anyhow!("--claude-settings requiere valor"))?)),
            "--opencode-config" => opencode_config = Some(PathBuf::from(it.next().ok_or_else(|| anyhow!("--opencode-config requiere valor"))?)),
            "--quiet" => quiet = true,
            "-h" | "--help" => {
                print_help();
                std::process::exit(0);
            }
            other => return Err(anyhow!("argumento desconocido: {other}")),
        }
    }

    Ok(Args {
        root: resolve(root, &[".config", "agent-rules"])?,
        claude_settings: resolve(claude_settings, &[".claude", "settings.json"])?,
        opencode_config: resolve(opencode_config, &[".config", "opencode", "opencode.json"])?,
        quiet,
    })
}

fn print_help() {
    println!("verify-rules — coherencia de agent-rules/");
    println!();
    println!("USO: verify-rules [opciones]");
    println!();
    println!("OPCIONES:");
    println!("  --root <path>             Raíz de agent-rules/");
    println!("  --claude-settings <path>  ~/.claude/settings.json");
    println!("  --opencode-config <path>  ~/.config/opencode/opencode.json");
    println!("  --quiet                   Silencia output si todo OK");
    println!("  -h, --help                Muestra esta ayuda");
}

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
#[allow(dead_code)]
struct Skill {
    slug: String,
    skill_md: PathBuf,
    name: String,
    agents: Vec<String>,
    enforced_by: Vec<EnforcedBy>,
    depends_on: Vec<String>,
}

#[derive(Debug, Clone)]
struct EnforcedBy {
    raw: String,
    path: Option<PathBuf>,
    agent: Option<String>,
}

#[derive(Debug, Default)]
struct Model {
    skills: BTreeMap<String, Skill>,
    catalog_skills: BTreeSet<String>,
    profiles: BTreeMap<String, Vec<String>>,
    claude_hooks: Vec<PathBuf>,
    opencode_instructions: Vec<PathBuf>,
    /// opencode agent.md → skills declared in frontmatter.
    opencode_agents: BTreeMap<String, Vec<String>>,
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Level { Ok, Warn, Fail }

#[derive(Debug, Clone)]
struct Finding {
    level: Level,
    category: &'static str,
    message: String,
}

impl Finding {
    fn ok(category: &'static str, message: impl Into<String>) -> Self { Self { level: Level::Ok, category, message: message.into() } }
    fn warn(category: &'static str, message: impl Into<String>) -> Self { Self { level: Level::Warn, category, message: message.into() } }
    fn fail(category: &'static str, message: impl Into<String>) -> Self { Self { level: Level::Fail, category, message: message.into() } }
}

// ---------------------------------------------------------------------------
// Frontmatter parser (mínimo, ad-hoc)
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct Frontmatter {
    fields: BTreeMap<String, FmValue>,
}

#[derive(Debug, Clone)]
enum FmValue {
    Scalar(String),
    List(Vec<String>),
}

fn parse_frontmatter(content: &str) -> Result<Frontmatter> {
    let mut lines = content.lines();
    let first = lines.next().ok_or_else(|| anyhow!("vacío"))?;
    if first.trim() != "---" {
        return Err(anyhow!("no inicia con ---"));
    }

    let mut block = String::new();
    for line in &mut lines {
        if line.trim() == "---" {
            return parse_fm_block(&block);
        }
        block.push_str(line);
        block.push('\n');
    }
    Err(anyhow!("frontmatter sin cierre ---"))
}

fn parse_fm_block(block: &str) -> Result<Frontmatter> {
    let mut fm = Frontmatter::default();
    let lines: Vec<&str> = block.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trim = line.trim_end();
        if trim.is_empty() || trim.trim_start().starts_with('#') {
            i += 1;
            continue;
        }
        // Solo claves al nivel raíz (sin indentación).
        if line.starts_with(' ') || line.starts_with('\t') {
            i += 1;
            continue;
        }
        let colon = trim.find(':').ok_or_else(|| anyhow!("línea sin ':': {trim}"))?;
        let key = trim[..colon].trim().to_string();
        let rest = trim[colon + 1..].trim();

        if rest.is_empty() {
            // Multilinea: leer ítems indentados con "- ".
            let mut items = Vec::new();
            let mut j = i + 1;
            while j < lines.len() {
                let l = lines[j];
                let lt = l.trim_start();
                if l.is_empty() {
                    j += 1;
                    continue;
                }
                if !l.starts_with(' ') && !l.starts_with('\t') {
                    break;
                }
                if let Some(item) = lt.strip_prefix("- ") {
                    items.push(item.trim().to_string());
                } else if lt.starts_with('-') {
                    items.push(lt[1..].trim().to_string());
                } else {
                    break;
                }
                j += 1;
            }
            fm.fields.insert(key, FmValue::List(items));
            i = j;
        } else if rest.starts_with('[') && rest.ends_with(']') {
            let inner = &rest[1..rest.len() - 1];
            let items: Vec<String> = if inner.trim().is_empty() {
                Vec::new()
            } else {
                inner.split(',').map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string()).collect()
            };
            fm.fields.insert(key, FmValue::List(items));
            i += 1;
        } else {
            let v = rest.trim_matches('"').trim_matches('\'').to_string();
            fm.fields.insert(key, FmValue::Scalar(v));
            i += 1;
        }
    }
    Ok(fm)
}

fn fm_scalar(fm: &Frontmatter, key: &str) -> Option<String> {
    match fm.fields.get(key) {
        Some(FmValue::Scalar(s)) => Some(s.clone()),
        _ => None,
    }
}

fn fm_list(fm: &Frontmatter, key: &str) -> Vec<String> {
    match fm.fields.get(key) {
        Some(FmValue::List(v)) => v.clone(),
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

fn load_skills(root: &Path) -> Result<BTreeMap<String, Skill>> {
    let skills_dir = root.join("skills");
    let mut out = BTreeMap::new();
    if !skills_dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(&skills_dir).with_context(|| format!("read_dir {}", skills_dir.display()))? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().to_string();
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let content = fs::read_to_string(&skill_md).with_context(|| format!("leer {}", skill_md.display()))?;
        let fm = parse_frontmatter(&content).with_context(|| format!("frontmatter {}", skill_md.display()))?;
        let name = fm_scalar(&fm, "name").unwrap_or_default();
        let agents = fm_list(&fm, "agents");
        let depends_on = fm_list(&fm, "depends_on");
        let enforced_by = fm_list(&fm, "enforced_by")
            .into_iter()
            .map(|raw| parse_enforced_by(&raw, &entry.path()))
            .collect();
        out.insert(
            slug.clone(),
            Skill { slug, skill_md, name, agents, enforced_by, depends_on },
        );
    }
    Ok(out)
}

fn parse_enforced_by(raw: &str, skill_dir: &Path) -> EnforcedBy {
    let trim = raw.trim();
    // formato: "hooks/foo.cjs (Event, Agente)" o "../../../opencode/plugins/guard.ts (...)".
    let path_part = trim.split('(').next().unwrap_or("").trim();
    let agent_part = trim
        .rfind('(')
        .and_then(|i| trim[i + 1..].rfind(')').map(|j| trim[i + 1..i + 1 + j].to_string()));

    let resolved = if path_part.is_empty() {
        None
    } else {
        Some(skill_dir.join(path_part))
    };

    let agent = agent_part.as_ref().and_then(|s| {
        let lower = s.to_lowercase();
        if lower.contains("claude") {
            Some("claude".to_string())
        } else if lower.contains("opencode") {
            Some("opencode".to_string())
        } else if lower.contains("codex") {
            Some("codex".to_string())
        } else {
            None
        }
    });

    EnforcedBy { raw: trim.to_string(), path: resolved, agent }
}

fn load_catalog(root: &Path) -> Result<BTreeSet<String>> {
    let path = root.join("catalog.md");
    if !path.exists() {
        return Ok(BTreeSet::new());
    }
    let content = fs::read_to_string(&path)?;
    Ok(extract_bullet_slugs(&content))
}

fn load_profiles(root: &Path) -> Result<BTreeMap<String, Vec<String>>> {
    let dir = root.join("profiles");
    let mut out = BTreeMap::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let agent = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let content = fs::read_to_string(&path)?;
        let slugs: Vec<String> = extract_bullet_slugs(&content).into_iter().collect();
        out.insert(agent, slugs);
    }
    Ok(out)
}

/// Extrae slugs de líneas tipo `- slug` o `- slug — descripción`.
fn extract_bullet_slugs(content: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for line in content.lines() {
        let t = line.trim_start();
        let Some(rest) = t.strip_prefix("- ") else { continue };
        let first = rest.split(|c: char| c.is_whitespace() || c == ':' || c == '—').next().unwrap_or("").trim();
        let first = first.trim_matches('`').trim_matches('*').trim_matches('_');
        if first.is_empty() { continue; }
        // Heurística: solo slugs que parezcan kebab-case (a-z, dígitos, guion).
        if first.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') {
            out.insert(first.to_string());
        }
    }
    out
}

fn load_claude_hooks(path: &Path) -> Result<Vec<PathBuf>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path)?;
    let v: Value = serde_json::from_str(&raw)?;
    let mut out = Vec::new();
    let events = ["SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionEnd", "Stop", "SubagentStop", "Notification"];
    for ev in events {
        let Some(arr) = v.get("hooks").and_then(|h| h.get(ev)).and_then(|x| x.as_array()) else { continue };
        for group in arr {
            let Some(hooks) = group.get("hooks").and_then(|x| x.as_array()) else { continue };
            for h in hooks {
                let Some(cmd) = h.get("command").and_then(|c| c.as_str()) else { continue };
                if let Some(p) = extract_node_path(cmd) {
                    out.push(p);
                }
            }
        }
    }
    Ok(out)
}

/// `node C:/.../foo.cjs` → `C:/.../foo.cjs`. Ignora hooks que no son node.
fn extract_node_path(cmd: &str) -> Option<PathBuf> {
    let t = cmd.trim();
    let rest = t.strip_prefix("node ")?.trim();
    let p = rest.split_whitespace().next()?;
    Some(PathBuf::from(p))
}

fn load_opencode_instructions(path: &Path) -> Result<Vec<PathBuf>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path)?;
    let v: Value = serde_json::from_str(&raw)?;
    let Some(arr) = v.get("instructions").and_then(|x| x.as_array()) else {
        return Ok(Vec::new());
    };
    Ok(arr.iter().filter_map(|x| x.as_str().map(PathBuf::from)).collect())
}

/// Lee opencode/agents/*.md (excluye _deprecated/) y devuelve {agent_filename → skills declarados}.
fn load_opencode_agents(opencode_config: &Path) -> Result<BTreeMap<String, Vec<String>>> {
    let mut out = BTreeMap::new();
    let Some(opencode_root) = opencode_config.parent() else { return Ok(out) };
    let agents_dir = opencode_root.join("agents");
    if !agents_dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(&agents_dir)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        if ft.is_dir() {
            // skip _deprecated/ y similares
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let content = fs::read_to_string(&path)?;
        let fm = match parse_frontmatter(&content) {
            Ok(fm) => fm,
            Err(_) => continue, // archivo sin frontmatter — ignorar
        };
        let skills = fm_list(&fm, "skills");
        out.insert(stem, skills);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

fn run_checks(m: &Model, root: &Path) -> Vec<Finding> {
    let mut f = Vec::new();
    check_skills(m, &mut f);
    check_catalog(m, &mut f);
    check_profiles(m, &mut f);
    check_settings(m, root, &mut f);
    check_opencode_agents(m, &mut f);
    check_cross_reference(m, root, &mut f);
    f
}

fn check_opencode_agents(m: &Model, out: &mut Vec<Finding>) {
    if m.opencode_agents.is_empty() {
        return;
    }
    let skills: BTreeSet<&str> = m.skills.keys().map(|s| s.as_str()).collect();
    for (agent, declared) in &m.opencode_agents {
        let mut bad = false;
        if declared.is_empty() {
            out.push(Finding::warn(
                "opencode-agents",
                format!("{agent}.md: frontmatter sin campo 'skills' (o vacío)"),
            ));
            continue;
        }
        for s in declared {
            if !skills.contains(s.as_str()) {
                out.push(Finding::fail(
                    "opencode-agents",
                    format!("{agent}.md: skill '{s}' declarada pero no existe en agent-rules/skills/"),
                ));
                bad = true;
                continue;
            }
            let skill = &m.skills[s];
            if !skill.agents.is_empty() && !skill.agents.iter().any(|a| a == "opencode") {
                out.push(Finding::warn(
                    "opencode-agents",
                    format!("{agent}.md: skill '{s}' no incluye 'opencode' en su frontmatter agents[]"),
                ));
            }
        }
        if !bad {
            out.push(Finding::ok(
                "opencode-agents",
                format!("{agent} → {}", declared.join(", ")),
            ));
        }
    }
}

fn check_skills(m: &Model, out: &mut Vec<Finding>) {
    if m.skills.is_empty() {
        out.push(Finding::fail("skills", "no se encontraron skills en skills/"));
        return;
    }

    let valid_agents = ["claude", "codex", "opencode"];
    let slugs: BTreeSet<&str> = m.skills.keys().map(|s| s.as_str()).collect();

    for (slug, s) in &m.skills {
        let mut local_fail = false;

        if s.name != *slug {
            out.push(Finding::fail(
                "skills",
                format!("{slug}: frontmatter name='{}' difiere del slug del directorio", s.name),
            ));
            local_fail = true;
        }
        for a in &s.agents {
            if !valid_agents.contains(&a.as_str()) {
                out.push(Finding::fail(
                    "skills",
                    format!("{slug}: agents incluye '{a}' (no es claude/codex/opencode)"),
                ));
                local_fail = true;
            }
        }
        for dep in &s.depends_on {
            if !slugs.contains(dep.as_str()) {
                out.push(Finding::fail(
                    "skills",
                    format!("{slug}: depends_on '{dep}' no existe como skill"),
                ));
                local_fail = true;
            }
        }
        for e in &s.enforced_by {
            let Some(p) = &e.path else {
                out.push(Finding::warn(
                    "skills",
                    format!("{slug}: enforced_by '{}' sin path parseable", e.raw),
                ));
                continue;
            };
            if !p.exists() {
                out.push(Finding::fail(
                    "skills",
                    format!("{slug}: enforced_by apunta a archivo inexistente: {}", p.display()),
                ));
                local_fail = true;
            }
        }

        if !local_fail {
            let agents = if s.agents.is_empty() { "(ninguno)".to_string() } else { s.agents.join(",") };
            let hooks = if s.enforced_by.is_empty() {
                "-".to_string()
            } else {
                s.enforced_by.iter().filter_map(|e| e.path.as_ref()).map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()).collect::<Vec<_>>().join(", ")
            };
            out.push(Finding::ok(
                "skills",
                format!("{slug:18} (agents: {agents}  hooks: {hooks})"),
            ));
        }
    }
}

fn check_catalog(m: &Model, out: &mut Vec<Finding>) {
    let skills: BTreeSet<&str> = m.skills.keys().map(|s| s.as_str()).collect();
    let catalog: BTreeSet<&str> = m.catalog_skills.iter().map(|s| s.as_str()).collect();

    for s in &skills {
        if !catalog.contains(s) {
            out.push(Finding::fail("catalog", format!("skill '{s}' existe pero NO está en catalog.md")));
        }
    }
    for c in &catalog {
        if !skills.contains(c) {
            out.push(Finding::warn("catalog", format!("catalog.md lista '{c}' pero skills/{c}/ no existe")));
        }
    }
    let listed = skills.intersection(&catalog).count();
    out.push(Finding::ok("catalog", format!("{listed}/{} skills listadas", m.skills.len())));
}

fn check_profiles(m: &Model, out: &mut Vec<Finding>) {
    let skills: BTreeSet<&str> = m.skills.keys().map(|s| s.as_str()).collect();
    let valid_agents = ["claude", "codex", "opencode"];

    if m.profiles.is_empty() {
        out.push(Finding::warn("profiles", "no se encontraron perfiles en profiles/"));
        return;
    }

    for (agent, slugs) in &m.profiles {
        if !valid_agents.contains(&agent.as_str()) {
            out.push(Finding::warn("profiles", format!("perfil '{agent}' no es agente conocido")));
            continue;
        }
        let mut bad = false;
        for s in slugs {
            if !skills.contains(s.as_str()) {
                out.push(Finding::fail("profiles", format!("{agent} → skill '{s}' no existe")));
                bad = true;
                continue;
            }
            let skill = &m.skills[s];
            if !skill.agents.is_empty() && !skill.agents.iter().any(|a| a == agent) {
                out.push(Finding::warn(
                    "profiles",
                    format!("{agent} lista '{s}' pero SKILL.md no incluye '{agent}' en agents"),
                ));
            }
        }
        if !bad {
            out.push(Finding::ok("profiles", format!("{agent} → {}", slugs.join(", "))));
        }
    }
}

fn check_settings(m: &Model, _root: &Path, out: &mut Vec<Finding>) {
    let mut bad = false;
    for p in &m.claude_hooks {
        if !p.exists() {
            out.push(Finding::fail("settings:claude", format!("hook registrado no existe: {}", p.display())));
            bad = true;
        }
    }
    if !bad && !m.claude_hooks.is_empty() {
        out.push(Finding::ok("settings:claude", format!("{} hooks registrados, todos existen", m.claude_hooks.len())));
    }

    let mut bad = false;
    for p in &m.opencode_instructions {
        if !p.exists() {
            out.push(Finding::fail("settings:opencode", format!("instructions[] path no existe: {}", p.display())));
            bad = true;
        }
    }
    if !bad && !m.opencode_instructions.is_empty() {
        out.push(Finding::ok("settings:opencode", format!("{} paths en instructions[], todos existen", m.opencode_instructions.len())));
    }
}

fn check_cross_reference(m: &Model, root: &Path, out: &mut Vec<Finding>) {
    // Normaliza paths para comparar.
    let claude_set: BTreeSet<PathBuf> = m.claude_hooks.iter().map(|p| normalize(p)).collect();

    // 1) Cada enforced_by Claude debe estar registrado en settings.json.
    let mut all_declared_claude: BTreeSet<PathBuf> = BTreeSet::new();
    for skill in m.skills.values() {
        for e in &skill.enforced_by {
            if e.agent.as_deref() == Some("claude") {
                if let Some(p) = &e.path {
                    let n = normalize(p);
                    all_declared_claude.insert(n.clone());
                    if !claude_set.contains(&n) {
                        out.push(Finding::fail(
                            "cross-reference",
                            format!("{}: enforced_by '{}' (Claude) no está registrado en settings.json", skill.slug, e.raw),
                        ));
                    }
                }
            }
        }
    }

    // 2) Cada hook de settings.json bajo skills/ debe estar declarado por alguna SKILL.md.
    let skills_root = normalize(&root.join("skills"));
    for p in &claude_set {
        if p.starts_with(&skills_root) && !all_declared_claude.contains(p) {
            out.push(Finding::warn(
                "cross-reference",
                format!("hook registrado en settings.json no está declarado en ningún SKILL.md: {}", p.display()),
            ));
        }
    }

    // 3) Para opencode: profiles/opencode.md debe alinearse con opencode.json.instructions[].
    if let Some(opencode_profile) = m.profiles.get("opencode") {
        let oc_instr_set: BTreeSet<PathBuf> = m.opencode_instructions.iter().map(|p| normalize(p)).collect();
        for slug in opencode_profile {
            let expected = normalize(&root.join("skills").join(slug).join("SKILL.md"));
            if !oc_instr_set.contains(&expected) {
                out.push(Finding::warn(
                    "cross-reference",
                    format!("opencode profile lista '{slug}' pero opencode.json.instructions[] no incluye {}", expected.display()),
                ));
            }
        }
    }

    if out.iter().filter(|f| f.category == "cross-reference" && f.level != Level::Ok).count() == 0 {
        out.push(Finding::ok("cross-reference", "todas las referencias coinciden"));
    }
}

fn normalize(p: &Path) -> PathBuf {
    let s = p.to_string_lossy().replace('\\', "/");
    PathBuf::from(s)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

fn report(args: &Args, findings: &[Finding]) -> (usize, usize) {
    let fails = findings.iter().filter(|f| f.level == Level::Fail).count();
    let warns = findings.iter().filter(|f| f.level == Level::Warn).count();

    if args.quiet {
        if fails == 0 && warns == 0 {
            return (fails, warns);
        }
        println!("agent-rules verify: {fails} fail, {warns} warn");
        for f in findings.iter().filter(|f| f.level != Level::Ok) {
            let tag = match f.level { Level::Fail => "fail", Level::Warn => "warn", Level::Ok => "ok" };
            println!("  {tag} [{}] {}", f.category, f.message);
        }
        return (fails, warns);
    }

    println!("agent-rules verify — root: {}", args.root.display());
    println!();

    let mut current_cat: &str = "";
    for f in findings {
        if f.category != current_cat {
            if !current_cat.is_empty() {
                println!();
            }
            println!("[{}]", f.category);
            current_cat = f.category;
        }
        let tag = match f.level { Level::Fail => "fail", Level::Warn => "warn", Level::Ok => "ok  " };
        println!("  {tag} {}", f.message);
    }

    println!();
    let verdict = if fails > 0 { "FAIL" } else if warns > 0 { "WARN" } else { "OK" };
    println!("result: {fails} fail, {warns} warn — {verdict}");
    (fails, warns)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() -> Result<()> {
    let args = parse_args()?;

    let model = Model {
        skills: load_skills(&args.root).context("cargar skills/")?,
        catalog_skills: load_catalog(&args.root).context("cargar catalog.md")?,
        profiles: load_profiles(&args.root).context("cargar profiles/")?,
        claude_hooks: load_claude_hooks(&args.claude_settings).context("cargar ~/.claude/settings.json")?,
        opencode_instructions: load_opencode_instructions(&args.opencode_config).context("cargar opencode.json")?,
        opencode_agents: load_opencode_agents(&args.opencode_config).context("cargar opencode/agents/")?,
    };

    let findings = run_checks(&model, &args.root);
    let (fails, warns) = report(&args, &findings);

    let code = if fails > 0 { 2 } else if warns > 0 { 1 } else { 0 };
    std::process::exit(code);
}
