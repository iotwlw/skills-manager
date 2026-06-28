interface SkillDescriptionLike {
  description?: string | null;
  description_zh?: string | null;
  source_origin?: {
    label?: string | null;
    detail?: string | null;
    repo?: string | null;
    kind?: string | null;
  } | null;
}

export interface SkillSourceFilterOption {
  key: string;
  label: string;
  kind: string;
}

const SOURCE_KIND_PRIORITY = ["official", "gstack", "repository", "local", "unknown"];

export function getSkillDescription(skill: SkillDescriptionLike) {
  return skill.description_zh?.trim() || skill.description?.trim() || "";
}

export function getSkillSearchText(skill: SkillDescriptionLike) {
  return [
    skill.description_zh,
    skill.description,
    skill.source_origin?.label,
    skill.source_origin?.detail,
    skill.source_origin?.repo,
    skill.source_origin?.kind,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .toLowerCase();
}

export function getSkillSourceLabel(skill: SkillDescriptionLike) {
  return skill.source_origin?.label?.trim() || "未知来源";
}

export function getSkillSourceKey(skill: SkillDescriptionLike) {
  const origin = skill.source_origin;
  const kind = origin?.kind?.trim() || "unknown";
  const label = getSkillSourceLabel(skill);
  const repo = origin?.repo?.trim();

  if (kind === "official") return `official:${label}`;
  if (kind === "repository") return `repository:${repo || label}`;
  if (kind === "gstack") return "gstack";
  if (kind === "local") return "local";
  if (kind === "unknown") return "unknown";
  return `${kind}:${repo || label}`;
}

export function getSkillSourceOptions(skills: readonly SkillDescriptionLike[]): SkillSourceFilterOption[] {
  const options = new Map<string, SkillSourceFilterOption>();
  for (const skill of skills) {
    const key = getSkillSourceKey(skill);
    if (!options.has(key)) {
      options.set(key, {
        key,
        label: getSkillSourceLabel(skill),
        kind: skill.source_origin?.kind?.trim() || "unknown",
      });
    }
  }

  return Array.from(options.values()).sort((a, b) => {
    const rankA = sourceKindRank(a.kind);
    const rankB = sourceKindRank(b.kind);
    if (rankA !== rankB) return rankA - rankB;
    return a.label.localeCompare(b.label);
  });
}

export function formatSkillSize(bytes?: number | null) {
  const value = typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${formatSizeNumber(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${formatSizeNumber(mb)} MB`;
  return `${formatSizeNumber(mb / 1024)} GB`;
}

function formatSizeNumber(value: number) {
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function sourceKindRank(kind: string) {
  const index = SOURCE_KIND_PRIORITY.indexOf(kind);
  return index === -1 ? SOURCE_KIND_PRIORITY.length : index;
}
