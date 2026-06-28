use serde::Serialize;

use super::skill_store::SkillRecord;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SkillSourceOrigin {
    pub kind: String,
    pub label: String,
    pub detail: Option<String>,
    pub repo: Option<String>,
    pub url: Option<String>,
}

impl SkillSourceOrigin {
    fn new(
        kind: &str,
        label: impl Into<String>,
        detail: Option<String>,
        repo: Option<String>,
        url: Option<String>,
    ) -> Self {
        Self {
            kind: kind.to_string(),
            label: label.into(),
            detail,
            repo,
            url,
        }
    }
}

pub fn local_source_origin(label: &str, detail: Option<String>) -> SkillSourceOrigin {
    SkillSourceOrigin::new("local", label, detail, None, None)
}

pub fn source_origin_for_skill(skill: &SkillRecord, tags: &[String]) -> SkillSourceOrigin {
    let haystack = [
        skill.name.as_str(),
        skill.source_ref.as_deref().unwrap_or_default(),
        skill.source_ref_resolved.as_deref().unwrap_or_default(),
        skill.source_subpath.as_deref().unwrap_or_default(),
        skill.central_path.as_str(),
        &tags.join(" "),
    ]
    .join(" ")
    .to_lowercase();

    if haystack.contains("gstack") || haystack.contains("gstask") {
        let repo = repo_slug_from_skill(skill);
        return SkillSourceOrigin::new(
            "gstack",
            "gstack",
            repo.clone(),
            repo,
            source_url(skill),
        );
    }

    if let Some(repo) = repo_slug_from_skill(skill) {
        if let Some(label) = official_label(&repo) {
            return SkillSourceOrigin::new(
                "official",
                label,
                Some(repo.clone()),
                Some(repo),
                source_url(skill),
            );
        }

        return SkillSourceOrigin::new(
            "repository",
            repo.clone(),
            Some(repo.clone()),
            Some(repo),
            source_url(skill),
        );
    }

    if matches!(skill.source_type.as_str(), "local" | "import") {
        return SkillSourceOrigin::new(
            "local",
            "本地",
            skill.source_ref.clone(),
            None,
            None,
        );
    }

    SkillSourceOrigin::new(
        "unknown",
        "未知来源",
        skill.source_ref.clone(),
        None,
        source_url(skill),
    )
}

fn official_label(repo: &str) -> Option<String> {
    let lower = repo.to_lowercase();
    if lower.starts_with("openai/") {
        Some("OpenAI 官方".to_string())
    } else if lower.starts_with("anthropics/") || lower.starts_with("anthropic/") {
        Some("Anthropic 官方".to_string())
    } else {
        None
    }
}

fn repo_slug_from_skill(skill: &SkillRecord) -> Option<String> {
    for value in [
        skill.source_ref_resolved.as_deref(),
        skill.source_ref.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(repo) = repo_slug_from_value(value) {
            return Some(repo);
        }
    }
    None
}

fn repo_slug_from_value(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    if let Some(github_pos) = trimmed.find("github.com") {
        let after = &trimmed[github_pos + "github.com".len()..];
        let after = after.trim_start_matches([':', '/', '\\']);
        return repo_slug_from_path(after);
    }

    // skills.sh stores references as owner/repo/skill-id. Keep the first two
    // path segments as the source repository.
    repo_slug_from_path(trimmed)
}

fn repo_slug_from_path(value: &str) -> Option<String> {
    let normalized = value.replace('\\', "/");
    let mut parts = normalized
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty());
    let owner = clean_repo_part(parts.next()?)?;
    let repo = clean_repo_part(parts.next()?)?;
    Some(format!("{owner}/{repo}"))
}

fn clean_repo_part(value: &str) -> Option<String> {
    let cleaned = value
        .trim_end_matches(".git")
        .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch.is_whitespace());
    if cleaned.is_empty()
        || cleaned == "."
        || cleaned == ".."
        || cleaned.contains(':')
        || cleaned.starts_with('.')
    {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn source_url(skill: &SkillRecord) -> Option<String> {
    skill.source_ref_resolved
        .as_deref()
        .or(skill.source_ref.as_deref())
        .and_then(|value| {
            let value = value.trim();
            if value.starts_with("http://") || value.starts_with("https://") {
                Some(value.to_string())
            } else if let Some(repo) = repo_slug_from_value(value) {
                Some(format!("https://github.com/{repo}"))
            } else {
                None
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(source_type: &str, source_ref: Option<&str>, source_ref_resolved: Option<&str>) -> SkillRecord {
        SkillRecord {
            id: "id".to_string(),
            name: "example".to_string(),
            description: None,
            source_type: source_type.to_string(),
            source_ref: source_ref.map(str::to_string),
            source_ref_resolved: source_ref_resolved.map(str::to_string),
            source_subpath: None,
            source_branch: None,
            source_revision: None,
            remote_revision: None,
            central_path: "/tmp/example".to_string(),
            content_hash: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
            status: "ok".to_string(),
            update_status: "unknown".to_string(),
            last_checked_at: None,
            last_check_error: None,
        }
    }

    #[test]
    fn classifies_openai_repo_as_official() {
        let origin = source_origin_for_skill(
            &skill("git", Some("https://github.com/openai/skills.git"), None),
            &[],
        );
        assert_eq!(origin.kind, "official");
        assert_eq!(origin.label, "OpenAI 官方");
        assert_eq!(origin.repo.as_deref(), Some("openai/skills"));
    }

    #[test]
    fn classifies_gstack_by_name_or_tag() {
        let mut rec = skill("git", Some("https://github.com/example/skills.git"), None);
        rec.name = "gstack-browse".to_string();
        let origin = source_origin_for_skill(&rec, &[]);
        assert_eq!(origin.kind, "gstack");
        assert_eq!(origin.label, "gstack");
    }

    #[test]
    fn parses_skillssh_repo_prefix() {
        let origin = source_origin_for_skill(
            &skill("skillssh", Some("owner/repo/my-skill"), None),
            &[],
        );
        assert_eq!(origin.kind, "repository");
        assert_eq!(origin.label, "owner/repo");
    }
}
