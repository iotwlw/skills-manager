# Skill 叉车 context 规范

## 目录

1. [设计目标](#设计目标)
2. [完整示例](#完整示例)
3. [字段说明](#字段说明)
4. [期望状态与实际状态](#期望状态与实际状态)
5. [路径规则](#路径规则)

## 设计目标

context 是可读、可审查、可放入版本控制的 JSON 文件。它只保存中央仓库位置、Codex 目标位置、项目清单和期望分配，不保存 SQLite 状态、缓存、文件哈希或插件数据。

## 完整示例

```json
{
  "version": 1,
  "warehouse": "~/.skills-manager/skills",
  "globalTarget": "~/.codex/skills",
  "codexConfig": "~/.codex/config.toml",
  "reportPath": "./skill-forklift-report.html",
  "globalSkills": [
    "skill-forklift"
  ],
  "projects": [
    {
      "id": "skills-manager",
      "name": "Skills Manager",
      "path": ".",
      "skillsDir": ".codex/skills",
      "skills": [
        "github-repo-study-planner"
      ]
    }
  ],
  "catalog": {
    "skill-forklift": {
      "source": "./skills/skill-forklift",
      "sourceType": "local",
      "subpath": null,
      "installedAt": "2026-07-10T00:00:00.000Z"
    }
  }
}
```

## 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 是 | 当前固定为 `1`。未知版本必须停止，不能猜测迁移。 |
| `warehouse` | 是 | 中央 Skill 仓库。每个直接子目录对应一个 Skill。 |
| `globalTarget` | 是 | Codex 用户级 Skill 目录，通常为 `~/.codex/skills`。 |
| `codexConfig` | 是 | 用于发现已信任项目的 Codex `config.toml`。 |
| `reportPath` | 是 | 独立 HTML 报告的输出路径。 |
| `globalSkills` | 是 | 期望映射到 `globalTarget` 的 Skill 名称。 |
| `projects` | 是 | 项目清单和项目期望 Skill。 |
| `catalog` | 否 | Forklift 安装时记录的来源提示；磁盘扫描仍是 Skill 是否存在的权威证据。 |

项目字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 命令行稳定引用，项目间必须唯一。 |
| `name` | 是 | HTML 报告中的显示名称。 |
| `path` | 是 | 项目根目录。 |
| `skillsDir` | 是 | 相对项目根目录的 Skill 目标目录，Codex 默认为 `.codex/skills`。 |
| `skills` | 是 | 期望映射到该项目的中央 Skill 名称。 |

## 期望状态与实际状态

- `globalSkills` 与 `projects[].skills` 是期望状态。
- 中央仓库、全局目录和项目目录的扫描结果是实际状态。
- `reconcile` 只补齐缺失的中央映射；只有显式 `--prune` 才移除配置外的中央映射。
- 普通实体目录、外部链接、失效链接都显示为未纳管或冲突，不自动删除。
- `catalog` 仅提供来源和安装时间，不替代 `SKILL.md` 和实际目录。

## 路径规则

- 支持 `~`、`${HOME}`、`${USERPROFILE}` 和 `%USERPROFILE%`。
- 相对路径以 context 文件所在目录为基准，而不是命令执行目录。
- 项目路径在 Windows 上按不区分大小写的规范化绝对路径去重。
- `skillsDir` 必须是项目内的相对子目录，不能使用绝对路径、`~` 或 `..` 逃逸。
- 不同项目解析后的 Skills 根目录不能相同、互相嵌套或通过 Junction 指向同一位置。
- `warehouse` 和 `globalTarget` 必须互不嵌套，也不能指向用户目录或磁盘根目录。
- `warehouse` 根可以是 Junction，但其中每个直接子 Skill 必须是实体目录。
- context 会先解析到物理路径再建立排他锁；若同一文件存在硬链接别名，修改命令必须停止。
- `reportPath` 不能位于 `warehouse`、`globalTarget` 或任何已登记项目的 Skills 根内，也不能与 context、`codexConfig` 或其他硬链接目标指向同一文件；盘符、UNC 和 Junction 等路径别名按文件身份判断。
- 已有 context 的必填字段、字段类型和 `version` 会在规范化前严格校验；缺失字段、错误类型或未知版本不会自动补默认值。
- Skill 名称遵循 `^[a-z0-9][a-z0-9-]{0,63}$`。
- `catalog[*].source` 写入和展示前会脱敏 URL 用户信息、全部 query/fragment，以及 authorization、token、secret、password、credential、signature、key、cookie 等敏感 header 值。
- context 可以放入版本控制；若包含个人绝对路径，应作为本地文件忽略，另提交去隐私的示例文件。
