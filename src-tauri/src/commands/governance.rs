use crate::core::{
    central_repo,
    error::AppError,
    governance::{self, GovernanceReport},
    repo_lock::RepoLock,
};

#[tauri::command]
pub async fn inspect_skill_governance() -> Result<GovernanceReport, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        governance::inspect_repository(&central_repo::skills_dir()).map_err(AppError::io)
    })
    .await?
}

#[tauri::command]
pub async fn verify_skill_governance_lock() -> Result<GovernanceReport, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        governance::verify_lock(&central_repo::skills_dir()).map_err(AppError::io)
    })
    .await?
}

#[tauri::command]
pub async fn create_skill_governance_lock(
    expected_root: String,
    mut expected_state: Vec<(String, Option<String>, Option<String>, String)>,
) -> Result<GovernanceReport, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RepoLock::acquire_foreground("建立技能版本基线").map_err(AppError::io)?;
        let root = central_repo::skills_dir();
        let current = governance::inspect_repository(&root).map_err(AppError::io)?;
        let mut actual: Vec<_> = current
            .skills
            .iter()
            .map(|skill| {
                (
                    skill.relative_path.clone(),
                    skill.content_hash.clone(),
                    skill.locked_hash.clone(),
                    skill.state.clone(),
                )
            })
            .collect();
        actual.sort();
        expected_state.sort();
        if current.root != expected_root || actual != expected_state {
            return Err(AppError::invalid_input(
                "确认期间技能库或基线已变化，请刷新后重新确认",
            ));
        }
        governance::create_lock_expected(&root, Some(&expected_state)).map_err(AppError::io)
    })
    .await?
}
