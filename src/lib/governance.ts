import { invoke } from "@tauri-apps/api/core";

export interface GovernanceIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path: string;
}

export type GovernanceState = "locked" | "changed" | "unlocked" | "missing" | "unreadable";

export interface GovernedSkill {
  name: string;
  relative_path: string;
  description: string | null;
  content_hash: string | null;
  locked_hash: string | null;
  state: GovernanceState;
  source: string | null;
  revision: string | null;
  issues: GovernanceIssue[];
}

export interface GovernanceReport {
  root: string;
  lock_path: string;
  lock_exists: boolean;
  skills: GovernedSkill[];
  issues: GovernanceIssue[];
  locked_count: number;
}

export const inspectSkillGovernance = () => invoke<GovernanceReport>("inspect_skill_governance");
export const createSkillGovernanceLock = (report: GovernanceReport) => invoke<GovernanceReport>("create_skill_governance_lock", {
  expectedRoot: report.root,
  expectedState: report.skills.map((skill) => [skill.relative_path, skill.content_hash, skill.locked_hash, skill.state]),
});
export const verifySkillGovernanceLock = () => invoke<GovernanceReport>("verify_skill_governance_lock");
