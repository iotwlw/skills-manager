//! 基于实际文件的 Skill 标准检查与内容基线；不执行脚本、不修改 Skill 内容。

use anyhow::{bail, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const LOCK_FILE_NAME: &str = "skills-manager.lock.json";
const GUARD_FILE_NAME: &str = ".skills-manager-governance.guard";
const HASH_ALGORITHM: &str = "sha256-framed-v1";
const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct GovernanceIssue {
    pub severity: String,
    pub code: String,
    pub message: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GovernedSkill {
    pub name: String,
    pub relative_path: String,
    pub description: Option<String>,
    pub content_hash: Option<String>,
    pub locked_hash: Option<String>,
    pub state: String,
    pub source: Option<String>,
    pub revision: Option<String>,
    pub issues: Vec<GovernanceIssue>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GovernanceReport {
    pub root: String,
    pub lock_path: String,
    pub lock_exists: bool,
    pub skills: Vec<GovernedSkill>,
    pub issues: Vec<GovernanceIssue>,
    pub locked_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LockManifest {
    schema_version: u32,
    hash_algorithm: String,
    skills: Vec<LockedSkill>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LockedSkill {
    relative_path: String,
    name: String,
    content_hash: String,
    source: Option<String>,
    revision: Option<String>,
}

fn issue(severity: &str, code: &str, message: impl Into<String>, path: &str) -> GovernanceIssue {
    GovernanceIssue {
        severity: severity.into(),
        code: code.into(),
        message: message.into(),
        path: path.into(),
    }
}

fn ignored(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "__pycache__"
            | ".pytest_cache"
            | ".mypy_cache"
            | ".DS_Store"
            | "Thumbs.db"
            | ".skills-manager"
            | LOCK_FILE_NAME
            | GUARD_FILE_NAME
    ) || name.ends_with(".pyc")
        || name.starts_with(".governance-tmp-")
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    false
}

fn regular_file(path: &Path) -> Result<Metadata> {
    let meta = fs::symlink_metadata(path)?;
    if is_link(&meta) || !meta.is_file() {
        bail!("不是可直接读取的普通文件：{}", path.display());
    }
    Ok(meta)
}

fn relative(root: &Path, path: &Path) -> Result<String> {
    let rel = path.strip_prefix(root)?;
    if rel.as_os_str().is_empty() {
        return Ok(".".into());
    }
    let mut parts = Vec::new();
    for part in rel.iter() {
        parts.push(
            part.to_str()
                .context("路径不是有效 UTF-8，无法建立可移植基线")?,
        );
    }
    Ok(parts.join("/"))
}

fn valid_relative(value: &str) -> bool {
    value == "."
        || (!value.is_empty()
            && !value.contains(['\\', ':'])
            && value.split('/').all(|s| {
                !s.is_empty() && s != "." && s != ".." && !s.chars().any(char::is_control)
            }))
}

fn sorted_entries(path: &Path) -> Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    Ok(entries)
}

fn discover(
    root: &Path,
    dir: &Path,
    found: &mut Vec<(PathBuf, String)>,
    issues: &mut Vec<GovernanceIssue>,
) {
    let rel = relative(root, dir).unwrap_or_else(|_| dir.display().to_string());
    let entries = match sorted_entries(dir) {
        Ok(entries) => entries,
        Err(err) => {
            issues.push(issue(
                "error",
                "scan_failed",
                format!("目录无法扫描：{err}"),
                &rel,
            ));
            return;
        }
    };
    for candidate in ["SKILL.md", "skill.md"] {
        if entries.iter().any(|e| e.file_name() == candidate) {
            found.push((dir.to_path_buf(), candidate.into()));
            return;
        }
    }
    for entry in entries {
        let name = entry.file_name();
        if ignored(&name.to_string_lossy()) {
            continue;
        }
        let path = entry.path();
        let rel = relative(root, &path).unwrap_or_else(|_| path.display().to_string());
        match fs::symlink_metadata(&path) {
            Ok(meta) if is_link(&meta) => issues.push(issue(
                "error",
                "linked_entry",
                "跳过符号链接或 Junction；请检查其所属位置，扫描未覆盖此内容。",
                &rel,
            )),
            Ok(meta) if meta.is_dir() => discover(root, &path, found, issues),
            Ok(_) => {}
            Err(err) => issues.push(issue(
                "error",
                "scan_failed",
                format!("无法读取目录项：{err}"),
                &rel,
            )),
        }
    }
}

fn content_files(root: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) -> Result<()> {
    for entry in sorted_entries(dir)? {
        if ignored(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)?;
        if is_link(&meta) {
            bail!("Skill 内含符号链接或 Junction：{}", relative(root, &path)?);
        }
        if meta.is_dir() {
            content_files(root, &path, files)?;
        } else if meta.is_file() {
            files.push((relative(root, &path)?, path));
        } else {
            bail!("Skill 内含非普通文件：{}", relative(root, &path)?);
        }
    }
    Ok(())
}

fn hash_skill(path: &Path) -> Result<String> {
    let mut files = Vec::new();
    content_files(path, path, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hash = Sha256::new();
    hash.update(b"skills-manager:sha256-framed-v1\0");
    for (name, path) in files {
        let before = regular_file(&path)?;
        hash.update((name.len() as u64).to_be_bytes());
        hash.update(name.as_bytes());
        hash.update(before.len().to_be_bytes());
        let mut file = File::open(&path)?;
        let mut buffer = [0u8; 65536];
        let mut bytes = 0u64;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            bytes += count as u64;
            hash.update(&buffer[..count]);
        }
        let after = regular_file(&path)?;
        if bytes != before.len() || before.modified()? != after.modified()? {
            bail!("扫描期间文件发生变化，请重试：{}", path.display());
        }
    }
    Ok(hex::encode(hash.finalize()))
}

fn document(path: &Path) -> Result<String> {
    let metadata = regular_file(path)?;
    if metadata.len() > MAX_DOCUMENT_BYTES {
        bail!("文档超过 2 MiB，未进行解析");
    }
    Ok(fs::read_to_string(path)?)
}

fn validate_document(
    content: &str,
    directory_name: &str,
    rel: &str,
) -> (Option<String>, Option<String>, Vec<GovernanceIssue>) {
    let mut issues = Vec::new();
    let mut lines = content.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim) != Some("---") {
        return (
            None,
            None,
            vec![issue(
                "error",
                "frontmatter_missing",
                "SKILL.md 必须以 YAML 元数据区开始。",
                rel,
            )],
        );
    }
    let mut yaml_lines = Vec::new();
    let mut closed = false;
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        yaml_lines.push(line);
    }
    if !closed {
        return (
            None,
            None,
            vec![issue(
                "error",
                "frontmatter_invalid",
                "YAML 元数据区缺少结束分隔线。",
                rel,
            )],
        );
    }
    let yaml = match serde_yaml::from_str::<serde_yaml::Value>(&yaml_lines.join("\n")) {
        Ok(value) if value.is_mapping() => value,
        _ => {
            return (
                None,
                None,
                vec![issue(
                    "error",
                    "frontmatter_invalid",
                    "YAML 元数据必须是有效的字段映射。",
                    rel,
                )],
            )
        }
    };
    let name = yaml.get("name").and_then(|v| v.as_str()).map(str::to_owned);
    let description = yaml
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    match name.as_deref() {
        Some(name)
            if !name.is_empty()
                && name.chars().count() <= 64
                && !name.starts_with('-')
                && !name.ends_with('-')
                && !name.contains("--")
                && name
                    .chars()
                    .all(|c| c == '-' || (c.is_alphanumeric() && !c.is_uppercase())) =>
        {
            if name != directory_name {
                issues.push(issue(
                    "warning",
                    "name_directory_mismatch",
                    "名称与所在目录不同；跨工具分发前请核对。",
                    rel,
                ));
            }
        }
        _ => issues.push(issue(
            "error",
            "name_invalid",
            "name 必须为 1–64 个小写字母、数字或连字符，不能以连字符开头/结尾或包含连续连字符。",
            rel,
        )),
    }
    if !description
        .as_deref()
        .is_some_and(|d| !d.trim().is_empty() && d.chars().count() <= 1024)
    {
        issues.push(issue(
            "error",
            "description_invalid",
            "description 必须是 1–1024 个字符的非空文本，说明用途与触发场景。",
            rel,
        ));
    }
    for key in ["license", "allowed-tools"] {
        if yaml.get(key).is_some_and(|v| !v.is_string()) {
            issues.push(issue(
                "warning",
                "field_type",
                format!("{key} 应为文本；部分工具扩展格式可能不支持跨工具使用。"),
                rel,
            ));
        }
    }
    if let Some(value) = yaml.get("compatibility") {
        if !value
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 500)
        {
            issues.push(issue(
                "error",
                "compatibility_invalid",
                "compatibility 必须是 1–500 个字符的文本。",
                rel,
            ));
        }
    }
    if let Some(value) = yaml.get("metadata") {
        if !value
            .as_mapping()
            .is_some_and(|m| m.iter().all(|(k, v)| k.is_string() && v.is_string()))
        {
            issues.push(issue(
                "warning",
                "metadata_invalid",
                "metadata 应为文本键值映射；建议将版本号等数字加引号。",
                rel,
            ));
        }
    }
    if content.lines().count() > 500 {
        issues.push(issue(
            "warning",
            "progressive_disclosure",
            "主文档超过 500 行；建议将详情拆入 references，按需加载。",
            rel,
        ));
    }
    (name, description, issues)
}

fn inspect_skill(root: &Path, path: &Path, filename: &str) -> Result<GovernedSkill> {
    let rel = relative(root, path)?;
    let fallback = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    let mut skill = GovernedSkill {
        name: fallback.into(),
        relative_path: rel.clone(),
        description: None,
        content_hash: None,
        locked_hash: None,
        state: "unlocked".into(),
        source: None,
        revision: None,
        issues: Vec::new(),
    };
    if filename != "SKILL.md" {
        skill.issues.push(issue(
            "warning",
            "legacy_filename",
            "使用了兼容文件名 skill.md，标准入口为 SKILL.md。",
            &rel,
        ));
    }
    match document(&path.join(filename)) {
        Ok(content) => {
            let (name, description, issues) = validate_document(&content, fallback, &rel);
            if let Some(name) = name {
                skill.name = name;
            }
            skill.description = description;
            skill.issues.extend(issues);
        }
        Err(err) => skill
            .issues
            .push(issue("error", "document_unreadable", err.to_string(), &rel)),
    }
    match hash_skill(path) {
        Ok(hash) => skill.content_hash = Some(hash),
        Err(err) => {
            skill.state = "unreadable".into();
            skill
                .issues
                .push(issue("error", "content_unreadable", err.to_string(), &rel));
        }
    }
    if fs::symlink_metadata(path.join("scripts")).is_ok() {
        skill.issues.push(issue(
            "info",
            "scripts_present",
            "包含可执行辅助脚本；本检查不会运行脚本，也不代表代码安全审计。",
            &rel,
        ));
    }
    Ok(skill)
}

fn sanitize_source(value: &str) -> Option<String> {
    if let Ok(mut url) = reqwest::Url::parse(value) {
        if !matches!(url.scheme(), "https" | "http" | "ssh" | "git") {
            return None;
        }
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        return Some(url.to_string());
    }
    let clean = value.split(['?', '#']).next()?.trim();
    let clean = clean
        .rsplit_once('@')
        .map(|(_, tail)| tail)
        .unwrap_or(clean);
    if clean.is_empty()
        || clean.chars().any(char::is_whitespace)
        || clean.starts_with('/')
        || clean.contains('\\')
    {
        None
    } else {
        Some(clean.into())
    }
}

fn attach_sources(root: &Path, report: &mut GovernanceReport) {
    let parent = root.join(".skills-manager");
    let dir = parent.join("skills");
    for path in [&parent, &dir] {
        match fs::symlink_metadata(path) {
            Ok(meta) if !is_link(&meta) && meta.is_dir() => {}
            Ok(_) => {
                report.issues.push(issue(
                    "warning",
                    "source_metadata_unreadable",
                    "来源元数据目录不是实体目录，未读取。",
                    ".skills-manager/skills",
                ));
                return;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => {
                report.issues.push(issue(
                    "warning",
                    "source_metadata_unreadable",
                    "来源元数据不可读取。",
                    ".skills-manager/skills",
                ));
                return;
            }
        }
    }
    let entries = match sorted_entries(&dir) {
        Ok(entries) => entries,
        Err(_) => {
            report.issues.push(issue(
                "warning",
                "source_metadata_unreadable",
                "来源元数据不可扫描。",
                ".skills-manager/skills",
            ));
            return;
        }
    };
    let mut seen = BTreeSet::new();
    for entry in entries {
        if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let value = document(&entry.path())
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
        let Some(value) =
            value.filter(|v| v.get("schema_version").and_then(|v| v.as_u64()) == Some(1))
        else {
            report.issues.push(issue(
                "warning",
                "source_metadata_invalid",
                "来源元数据无效或版本未知，未用于来源判断。",
                ".skills-manager/skills",
            ));
            continue;
        };
        let Some(path) = value
            .get("path")
            .and_then(|v| v.as_str())
            .filter(|p| valid_relative(p))
        else {
            continue;
        };
        if !seen.insert(path.to_owned()) {
            report.issues.push(issue(
                "warning",
                "source_metadata_duplicate",
                "同一路径有多份来源记录，请先整理元数据。",
                path,
            ));
            continue;
        }
        if let Some(skill) = report.skills.iter_mut().find(|s| s.relative_path == path) {
            let source = &value["source"];
            if !matches!(source["type"].as_str(), Some("local" | "import")) {
                skill.source = source["ref"].as_str().and_then(sanitize_source);
            }
        }
    }
}

fn ensure_single_link(file: &File) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata()?.nlink() != 1 {
            bail!("拒绝访问有硬链接别名的治理文件");
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct FileInfo {
            attributes: u32,
            creation: [u32; 2],
            access: [u32; 2],
            write: [u32; 2],
            volume: u32,
            size_high: u32,
            size_low: u32,
            links: u32,
            index_high: u32,
            index_low: u32,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFileInformationByHandle(
                handle: *mut std::ffi::c_void,
                info: *mut FileInfo,
            ) -> i32;
        }
        let mut info = std::mem::MaybeUninit::<FileInfo>::uninit();
        // Windows 的公开句柄 API 用于拒绝硬链接别名，不依赖不稳定的 MetadataExt 方法。
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if unsafe { info.assume_init() }.links != 1 {
            bail!("拒绝访问有硬链接别名的治理文件");
        }
    }
    Ok(())
}

fn read_lock(path: &Path) -> Result<Option<LockManifest>> {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
        Ok(_) => {}
    }
    regular_file(path)?;
    let file = File::open(path)?;
    ensure_single_link(&file)?;
    if file.metadata()?.len() > 16 * 1024 * 1024 {
        bail!("锁文件超过 16 MiB");
    }
    let manifest: LockManifest = serde_json::from_reader(file).context("锁文件格式无效")?;
    if manifest.schema_version != 1 || manifest.hash_algorithm != HASH_ALGORITHM {
        bail!("锁文件版本或哈希算法不受支持");
    }
    let mut seen = BTreeSet::new();
    for skill in &manifest.skills {
        if !valid_relative(&skill.relative_path) || !seen.insert(skill.relative_path.clone()) {
            bail!("锁文件包含不安全或重复路径");
        }
        if skill.content_hash.len() != 64
            || !skill
                .content_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            bail!("锁文件包含无效 SHA-256");
        }
        if skill.revision.as_deref().is_some_and(|revision| {
            !matches!(revision.len(), 40 | 64) || !revision.bytes().all(|b| b.is_ascii_hexdigit())
        }) {
            bail!("锁文件包含无效的不可变来源版本");
        }
    }
    Ok(Some(manifest))
}

/// 扫描磁盘内容并比较本地基线；此入口不会创建文件或初始化数据库。
pub fn inspect_repository(root: &Path) -> Result<GovernanceReport> {
    let root = fs::canonicalize(root).context("技能仓库不可访问")?;
    if !root.is_dir() {
        bail!("技能仓库必须是目录");
    }
    let lock_path = root.join(LOCK_FILE_NAME);
    let mut report = GovernanceReport {
        root: root.display().to_string(),
        lock_path: lock_path.display().to_string(),
        lock_exists: fs::symlink_metadata(&lock_path).is_ok(),
        skills: Vec::new(),
        issues: Vec::new(),
        locked_count: 0,
    };
    let manifest = match read_lock(&lock_path) {
        Ok(manifest) => manifest,
        Err(err) => {
            report.issues.push(issue(
                "error",
                "lock_invalid",
                err.to_string(),
                LOCK_FILE_NAME,
            ));
            None
        }
    };
    let mut found = Vec::new();
    discover(&root, &root, &mut found, &mut report.issues);
    for (path, filename) in found {
        match inspect_skill(&root, &path, &filename) {
            Ok(skill) => report.skills.push(skill),
            Err(err) => report.issues.push(issue(
                "error",
                "scan_failed",
                err.to_string(),
                &path.display().to_string(),
            )),
        }
    }
    attach_sources(&root, &mut report);
    if let Some(manifest) = manifest {
        report.locked_count = manifest.skills.len();
        let mut locked: BTreeMap<_, _> = manifest
            .skills
            .into_iter()
            .map(|s| (s.relative_path.clone(), s))
            .collect();
        for skill in &mut report.skills {
            if let Some(entry) = locked.remove(&skill.relative_path) {
                skill.locked_hash = Some(entry.content_hash.clone());
                let locked_source = entry.source.as_deref().and_then(sanitize_source);
                if skill.source.is_none() {
                    skill.source = locked_source.clone();
                }
                if let Some(hash) = &skill.content_hash {
                    skill.state = if hash == &entry.content_hash {
                        "locked"
                    } else {
                        "changed"
                    }
                    .into();
                    // 仅在来源与内容均未变化时沿用已知提交，避免把本地编辑冒充为该提交内容。
                    if hash == &entry.content_hash && skill.source == locked_source {
                        skill.revision = entry.revision;
                    }
                }
            }
        }
        for (_, entry) in locked {
            let missing_issue = issue(
                "warning",
                "locked_skill_missing",
                "此路径记录在基线中，但磁盘上未找到技能；重新建立基线将移除此记录。",
                &entry.relative_path,
            );
            report.skills.push(GovernedSkill {
                name: entry.name,
                relative_path: entry.relative_path,
                description: None,
                content_hash: None,
                locked_hash: Some(entry.content_hash),
                state: "missing".into(),
                source: entry.source.as_deref().and_then(sanitize_source),
                revision: entry.revision,
                issues: vec![missing_issue],
            });
        }
    }
    report
        .skills
        .sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    let mut hashes: BTreeMap<String, String> = BTreeMap::new();
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for skill in &mut report.skills {
        if skill.state == "missing" {
            continue;
        }
        if let Some(first) = names.insert(skill.name.clone(), skill.relative_path.clone()) {
            skill.issues.push(issue(
                "warning",
                "duplicate_name",
                format!("名称与 {first} 相同，分发时可能产生覆盖或触发歧义。"),
                &skill.relative_path,
            ));
        }
        if let Some(hash) = &skill.content_hash {
            if let Some(first) = hashes.insert(hash.clone(), skill.relative_path.clone()) {
                skill.issues.push(issue(
                    "info",
                    "duplicate_content",
                    format!("内容与 {first} 完全相同，可考虑集中维护。"),
                    &skill.relative_path,
                ));
            }
        }
    }
    Ok(report)
}

/// 校验包含缺失基线提示，方便 CLI 将不一致状态转为非零退出码。
pub fn verify_lock(root: &Path) -> Result<GovernanceReport> {
    let mut report = inspect_repository(root)?;
    if !report.lock_exists {
        report.issues.push(issue(
            "error",
            "lock_missing",
            "尚未建立内容基线。",
            LOCK_FILE_NAME,
        ));
    }
    Ok(report)
}

/// 对当前内容建立基线。锁文件只是本地内容快照，不是远端安装/恢复清单。
pub fn create_lock(root: &Path) -> Result<GovernanceReport> {
    create_lock_expected(root, None)
}

/// UI 提交预览时提供路径、当前哈希、基线哈希和状态；持锁后再次确认预览未失效。
pub type ExpectedSkillState = (String, Option<String>, Option<String>, String);

fn check_expected(
    report: &GovernanceReport,
    expected: Option<&[ExpectedSkillState]>,
) -> Result<()> {
    if let Some(expected) = expected {
        let mut actual: Vec<_> = report
            .skills
            .iter()
            .map(|s| {
                (
                    s.relative_path.clone(),
                    s.content_hash.clone(),
                    s.locked_hash.clone(),
                    s.state.clone(),
                )
            })
            .collect();
        let mut expected = expected.to_vec();
        actual.sort();
        expected.sort();
        if actual != expected {
            bail!("预览已过期：技能内容或基线已经变化，请刷新后重新确认");
        }
    }
    Ok(())
}

pub fn create_lock_expected(
    root: &Path,
    expected_state: Option<&[ExpectedSkillState]>,
) -> Result<GovernanceReport> {
    let root = fs::canonicalize(root).context("技能仓库不可访问")?;
    let guard_path = root.join(GUARD_FILE_NAME);
    if fs::symlink_metadata(&guard_path).is_ok() {
        regular_file(&guard_path)?;
    }
    let guard = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&guard_path)?;
    ensure_single_link(&guard)?;
    guard
        .try_lock_exclusive()
        .context("另一项内容基线操作正在进行，请稍后重试")?;
    // 不删除锁文件：进程退出自动释放操作系统锁，避免崩溃后永久阻塞。
    let report = inspect_repository(&root)?;
    check_expected(&report, expected_state)?;
    if report
        .issues
        .iter()
        .chain(report.skills.iter().flat_map(|s| &s.issues))
        .any(|i| i.severity == "error")
    {
        bail!("存在检查错误，未写入基线；请先处理检查报告");
    }
    let entries = report
        .skills
        .iter()
        .filter(|s| s.state != "missing")
        .map(|skill| {
            Ok(LockedSkill {
                relative_path: skill.relative_path.clone(),
                name: skill.name.clone(),
                content_hash: skill.content_hash.clone().context("技能内容不可读取")?,
                source: skill.source.clone(),
                revision: skill.revision.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    // 写入前再检查一次内容，避免将扫描期间发生变动的目录误记为稳定版本。
    let second = inspect_repository(&root)?;
    check_expected(&second, expected_state)?;
    if second
        .issues
        .iter()
        .chain(second.skills.iter().flat_map(|s| &s.issues))
        .any(|i| i.severity == "error")
    {
        bail!("复核时出现检查错误，未写入基线");
    }
    let expected: BTreeMap<_, _> = entries
        .iter()
        .map(|s| (s.relative_path.as_str(), Some(s.content_hash.as_str())))
        .collect();
    let actual: BTreeMap<_, _> = second
        .skills
        .iter()
        .filter(|s| s.state != "missing")
        .map(|s| (s.relative_path.as_str(), s.content_hash.as_deref()))
        .collect();
    if expected != actual {
        bail!("扫描期间内容或目录清单发生变化，请重试");
    }
    let manifest = LockManifest {
        schema_version: 1,
        hash_algorithm: HASH_ALGORITHM.into(),
        skills: entries,
    };
    let lock_path = root.join(LOCK_FILE_NAME);
    read_lock(&lock_path)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".governance-tmp-")
        .tempfile_in(&root)?;
    serde_json::to_writer_pretty(&mut temp, &manifest)?;
    temp.write_all(b"\n")?;
    temp.as_file().sync_all()?;
    temp.persist(&lock_path)
        .map_err(|err| err.error)
        .context("无法原子保存内容基线")?;
    drop(guard);
    inspect_repository(&root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn skill(root: &Path, name: &str) -> PathBuf {
        let path = root.join(name);
        fs::create_dir_all(&path).unwrap();
        fs::write(
            path.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: 用于验证内容基线\n---\n正文\n"),
        )
        .unwrap();
        path
    }

    #[test]
    fn tracks_changes_additions_and_removals_without_modifying_skills() {
        let tmp = tempdir().unwrap();
        let first = skill(tmp.path(), "first");
        let second = skill(tmp.path(), "second");
        let baseline = create_lock(tmp.path()).unwrap();
        assert_eq!(baseline.locked_count, 2);
        assert!(baseline.skills.iter().all(|s| s.state == "locked"));
        fs::write(first.join("extra.txt"), "new content").unwrap();
        fs::remove_dir_all(second).unwrap();
        skill(tmp.path(), "third");
        let report = verify_lock(tmp.path()).unwrap();
        assert_eq!(
            report
                .skills
                .iter()
                .map(|s| (s.name.as_str(), s.state.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("first", "changed"),
                ("second", "missing"),
                ("third", "unlocked")
            ]
        );
        assert!(first.join("extra.txt").exists());
    }

    #[test]
    fn lock_is_deterministic_and_preserves_other_ecosystem_lock() {
        let tmp = tempdir().unwrap();
        skill(tmp.path(), "sample");
        fs::write(tmp.path().join("skills-lock.json"), "foreign lock").unwrap();
        create_lock(tmp.path()).unwrap();
        let original = fs::read(tmp.path().join(LOCK_FILE_NAME)).unwrap();
        create_lock(tmp.path()).unwrap();
        assert_eq!(original, fs::read(tmp.path().join(LOCK_FILE_NAME)).unwrap());
        assert_eq!(
            fs::read_to_string(tmp.path().join("skills-lock.json")).unwrap(),
            "foreign lock"
        );
    }

    #[test]
    fn malformed_or_future_lock_is_never_overwritten() {
        let tmp = tempdir().unwrap();
        skill(tmp.path(), "sample");
        for raw in [
            "broken",
            r#"{"schema_version":9,"hash_algorithm":"sha256-framed-v1","skills":[]}"#,
            r#"{"schema_version":1,"hash_algorithm":"sha256-framed-v1","skills":[{"relative_path":"../outside","name":"bad","content_hash":"x","source":null,"revision":null}]}"#,
        ] {
            fs::write(tmp.path().join(LOCK_FILE_NAME), raw).unwrap();
            assert!(inspect_repository(tmp.path())
                .unwrap()
                .issues
                .iter()
                .any(|i| i.code == "lock_invalid"));
            assert!(create_lock(tmp.path()).is_err());
            assert_eq!(
                fs::read_to_string(tmp.path().join(LOCK_FILE_NAME)).unwrap(),
                raw
            );
        }
    }

    #[test]
    fn strict_frontmatter_and_advisory_portability_checks() {
        let content = "---\nname: bad--name\ndescription: ''\ncompatibility: 12\nmetadata:\n  version: 1\nallowed-tools: [Bash]\n---\n";
        let (_, _, issues) = validate_document(content, "folder", "folder");
        for code in [
            "name_invalid",
            "description_invalid",
            "compatibility_invalid",
            "metadata_invalid",
            "field_type",
        ] {
            assert!(issues.iter().any(|i| i.code == code), "missing {code}");
        }
        let content = "---\nname: sample\ndescription: Contains --- safely\n---\ntext";
        let (_, desc, issues) = validate_document(content, "sample", "sample");
        assert_eq!(desc.as_deref(), Some("Contains --- safely"));
        assert!(issues.is_empty());
    }

    #[test]
    fn invalid_document_blocks_lock_and_scans_are_read_only() {
        let tmp = tempdir().unwrap();
        let sample = skill(tmp.path(), "sample");
        fs::write(sample.join("SKILL.md"), "# missing metadata").unwrap();
        let report = verify_lock(tmp.path()).unwrap();
        assert!(report.issues.iter().any(|i| i.code == "lock_missing"));
        assert!(!tmp.path().join(GUARD_FILE_NAME).exists());
        assert!(create_lock(tmp.path()).is_err());
        assert!(!tmp.path().join(LOCK_FILE_NAME).exists());
    }

    #[test]
    fn missing_root_is_an_error_not_an_empty_success() {
        let tmp = tempdir().unwrap();
        assert!(inspect_repository(&tmp.path().join("missing")).is_err());
    }

    #[test]
    fn no_hash_collision_between_filenames_and_content_boundaries() {
        let tmp = tempdir().unwrap();
        let left = tmp.path().join("left");
        let right = tmp.path().join("right");
        fs::create_dir(&left).unwrap();
        fs::create_dir(&right).unwrap();
        fs::write(left.join("a"), "bc").unwrap();
        fs::write(right.join("ab"), "c").unwrap();
        assert_ne!(hash_skill(&left).unwrap(), hash_skill(&right).unwrap());
    }

    #[test]
    fn source_metadata_redacts_credentials_and_does_not_invent_revision() {
        let tmp = tempdir().unwrap();
        skill(tmp.path(), "sample");
        let dir = tmp.path().join(".skills-manager/skills");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("sample.json"), r#"{"schema_version":1,"path":"sample","source":{"type":"git","ref":"https://alice:secret@github.com/org/repo?token=secret#secret","branch":"main"}}"#).unwrap();
        let report = create_lock(tmp.path()).unwrap();
        assert_eq!(
            report.skills[0].source.as_deref(),
            Some("https://github.com/org/repo")
        );
        assert_eq!(report.skills[0].revision, None);
        assert!(!fs::read_to_string(tmp.path().join(LOCK_FILE_NAME))
            .unwrap()
            .contains("secret"));
    }

    #[test]
    fn reports_duplicate_content_and_ignores_runtime_cache() {
        let tmp = tempdir().unwrap();
        let first = skill(tmp.path(), "sample");
        let other = tmp.path().join("group/sample");
        fs::create_dir_all(&other).unwrap();
        fs::copy(first.join("SKILL.md"), other.join("SKILL.md")).unwrap();
        let before = hash_skill(&first).unwrap();
        fs::create_dir(first.join("__pycache__")).unwrap();
        fs::write(first.join("__pycache__/generated.pyc"), "runtime artifact").unwrap();
        assert_eq!(before, hash_skill(&first).unwrap());
        let report = inspect_repository(tmp.path()).unwrap();
        assert!(report
            .skills
            .iter()
            .flat_map(|s| &s.issues)
            .any(|i| i.code == "duplicate_content"));
        assert!(report
            .skills
            .iter()
            .flat_map(|s| &s.issues)
            .any(|i| i.code == "duplicate_name"));
    }

    #[test]
    fn hardlinked_manifest_is_refused() {
        let tmp = tempdir().unwrap();
        skill(tmp.path(), "sample");
        create_lock(tmp.path()).unwrap();
        fs::hard_link(
            tmp.path().join(LOCK_FILE_NAME),
            tmp.path().join("alias.json"),
        )
        .unwrap();
        assert!(create_lock(tmp.path()).is_err());
        assert!(inspect_repository(tmp.path())
            .unwrap()
            .issues
            .iter()
            .any(|i| i.code == "lock_invalid"));
    }

    #[test]
    fn operating_system_lock_recovers_without_deleting_guard() {
        let tmp = tempdir().unwrap();
        skill(tmp.path(), "sample");
        let guard = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(tmp.path().join(GUARD_FILE_NAME))
            .unwrap();
        guard.try_lock_exclusive().unwrap();
        assert!(create_lock(tmp.path()).is_err());
        drop(guard);
        assert!(create_lock(tmp.path()).is_ok());
    }

    #[test]
    fn old_preview_cannot_accept_new_content_or_new_baseline() {
        let tmp = tempdir().unwrap();
        let sample = skill(tmp.path(), "sample");
        let report = create_lock(tmp.path()).unwrap();
        let expected: Vec<_> = report
            .skills
            .iter()
            .map(|s| {
                (
                    s.relative_path.clone(),
                    s.content_hash.clone(),
                    s.locked_hash.clone(),
                    s.state.clone(),
                )
            })
            .collect();
        fs::write(sample.join("changed.txt"), "new bytes").unwrap();
        assert!(create_lock_expected(tmp.path(), Some(&expected)).is_err());
        assert_eq!(
            inspect_repository(tmp.path()).unwrap().skills[0].state,
            "changed"
        );
        let fresh = inspect_repository(tmp.path()).unwrap();
        let expected: Vec<_> = fresh
            .skills
            .iter()
            .map(|s| {
                (
                    s.relative_path.clone(),
                    s.content_hash.clone(),
                    s.locked_hash.clone(),
                    s.state.clone(),
                )
            })
            .collect();
        assert!(create_lock_expected(tmp.path(), Some(&expected)).is_ok());
        assert!(create_lock_expected(tmp.path(), Some(&expected)).is_err());
    }

    #[test]
    fn existing_provenance_survives_missing_sidecar_but_revision_does_not_certify_edits() {
        let tmp = tempdir().unwrap();
        let sample = skill(tmp.path(), "sample");
        create_lock(tmp.path()).unwrap();
        let path = tmp.path().join(LOCK_FILE_NAME);
        let mut manifest = read_lock(&path).unwrap().unwrap();
        manifest.skills[0].source = Some("https://github.com/example/repo".into());
        manifest.skills[0].revision = Some("a".repeat(40));
        fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let report = create_lock(tmp.path()).unwrap();
        assert_eq!(
            report.skills[0].source.as_deref(),
            Some("https://github.com/example/repo")
        );
        assert_eq!(report.skills[0].revision, Some("a".repeat(40)));
        fs::write(sample.join("edit.txt"), "local change").unwrap();
        let report = create_lock(tmp.path()).unwrap();
        assert_eq!(report.skills[0].revision, None);
    }

    #[cfg(windows)]
    #[test]
    fn junction_is_not_followed_or_silently_certified() {
        let tmp = tempdir().unwrap();
        let external = tempdir().unwrap();
        skill(external.path(), "outside");
        junction::create(external.path(), tmp.path().join("linked")).unwrap();
        let report = inspect_repository(tmp.path()).unwrap();
        assert!(report.skills.is_empty());
        assert!(report.issues.iter().any(|i| i.code == "linked_entry"));
        assert!(create_lock(tmp.path()).is_err());
        junction::delete(tmp.path().join("linked")).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_inside_skill_fail_hashing_without_reading_target() {
        let tmp = tempdir().unwrap();
        let external = tempdir().unwrap();
        let sample = skill(tmp.path(), "sample");
        fs::write(external.path().join("secret"), "private").unwrap();
        std::os::unix::fs::symlink(external.path().join("secret"), sample.join("linked")).unwrap();
        let report = inspect_repository(tmp.path()).unwrap();
        assert_eq!(report.skills[0].state, "unreadable");
        assert!(create_lock(tmp.path()).is_err());
    }
}
