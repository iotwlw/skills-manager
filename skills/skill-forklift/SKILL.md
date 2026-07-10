---
name: skill-forklift
description: 以“中央 Skill 仓库 + Codex 全局 Junction + 项目级 Junction”的轻量模型管理本机 Skills，并通过单一 JSON context 维护项目和分配关系、安装或接管 Skill、检查配置漂移、生成独立 HTML 管理报告。用户提到“叉车”、管理/安装/迁移/分配/移除 Skill、查看全局或某项目有哪些 Skill、把 Skill 映射到项目、整理 Codex Skills、生成 Skill 清单或 HTML 报告时使用。
---

# Skill 叉车

只管理 Codex，不引入数据库、Preset、桌面 UI 或多 Agent 适配层。把 Skill 实体集中放在一个仓库中；全局目录和项目目录只放指向中央实体的符号链接或 Windows Junction。

## 核心模型

- 把 `context` 作为期望状态和项目清单的唯一配置文件。
- 把中央仓库作为 Skill 实体的唯一真源。
- 把 `~/.codex/skills/<skill>` 作为全局映射。
- 把 `<project>/.codex/skills/<skill>` 作为项目映射。
- 把磁盘扫描结果作为实际状态；报告同时展示期望状态、实际状态和漂移。
- 不把 Codex 内置 `.system`、插件缓存或普通实体目录误删为 Forklift 映射。

详细字段见 [context 规范](references/context-schema.md)。

## 定位脚本和 context

在 PowerShell 中定位已安装脚本：

```powershell
$forklift = "$HOME\.codex\skills\skill-forklift\scripts\forklift.mjs"
```

按以下优先级确定 context：

1. 用户明确给出的路径。
2. 环境变量 `SKILL_FORKLIFT_CONTEXT`。
3. 从当前工作目录向上查找 `skill-forklift.context.json`。
4. 用户目录中的 `~/.skill-forklift/context.json`。
5. 已知管理仓库中的 context；若仍不明确，只询问一次路径，不要猜测多个配置源。

机器读取输出时始终传入 `--json`：

```powershell
node $forklift inventory --context <context路径> --json
```

## 首次初始化

在用户指定的管理目录中初始化。该命令会读取 `~/.codex/config.toml` 中现存的项目表，并识别已经指向中央仓库的全局/项目 Junction：

```powershell
node $forklift init --context <context路径> --json
node $forklift report --context <context路径> --json
```

如果 context 已存在，不要使用 `--force` 覆盖，除非用户明确要求重建且已查看原文件。

## 每次操作的固定流程

1. 先运行 `inventory --json`，确认中央仓库、目标目录和当前漂移。
2. 判断作用域：
   - 整个 Codex 都要使用：`global`。
   - 只服务某个代码库：`project`。
   - 暂时只收藏：只安装到中央仓库，不分配。
3. 对移除、接管、批量对齐等高影响动作先运行 `--dry-run`。
4. 执行实际变更。
5. 再运行 `inventory --json` 和 `report --json`。
6. 向用户报告：中央仓库变化、全局变化、项目变化、冲突、备份路径和 HTML 报告路径。

## 安装与接管

从本地 Skill 目录安装到中央仓库：

```powershell
node $forklift install <本地目录> --context <context路径> --json
```

从 Git 仓库或 GitHub `tree` URL 安装：

```powershell
node $forklift install <Git URL> --subpath <skill子目录> --context <context路径> --json
```

Git 来源的预演不联网、不创建临时克隆，因此必须显式给出预期名称；实际安装时再读取远端并校验 `SKILL.md`：

```powershell
node $forklift install <Git URL> --name <skill名称> --dry-run --context <context路径> --json
```

安装后立即配置为全局或项目 Skill：

```powershell
node $forklift install <来源> --scope global --context <context路径> --json
node $forklift install <来源> --scope project --project <项目ID> --context <context路径> --json
```

当目标目录里已经存在真实 Skill 副本时，使用 `adopt`，不要直接删除或覆盖。`adopt` 只接受目标位置中的本地实体目录，并且必须指定作用域；Git 来源、中央仓库外的普通来源或缺少作用域时改用 `install`。成功接管会先复制到中央仓库，再把原目录移动到相邻的 `.skill-forklift-backups`，最后建立 Junction：

```powershell
node $forklift adopt <现有Skill目录> --scope global --context <context路径> --dry-run --json
node $forklift adopt <现有Skill目录> --scope global --context <context路径> --json
```

保留并报告备份路径；不要自动删除备份。

## 全局和项目分配

新增项目：

```powershell
node $forklift project-add --path <项目目录> --name <显示名称> --context <context路径> --json
```

重新读取 Codex 已信任项目：

```powershell
node $forklift discover-projects --context <context路径> --dry-run --json
node $forklift discover-projects --context <context路径> --json
```

移除项目登记前先预演。项目离线时不能证明其磁盘上没有 context 外映射，默认停止；只有用户确认放弃扫描时才同时使用 `--force --allow-unavailable`：

```powershell
node $forklift project-remove --project <项目ID> --dry-run --context <context路径> --json
node $forklift project-remove --project <项目ID> --force --allow-unavailable --context <context路径> --json
```

分配 Skill：

```powershell
node $forklift assign <skill> --scope global --context <context路径> --json
node $forklift assign <skill> --scope project --project <项目ID> --context <context路径> --json
```

解除分配：

```powershell
node $forklift unassign <skill> --scope project --project <项目ID> --context <context路径> --dry-run --json
node $forklift unassign <skill> --scope project --project <项目ID> --context <context路径> --json
```

解除分配只能删除可证明指向中央仓库的链接或 Junction；遇到真实目录、外部链接或失效链接时停止并报告冲突。

## 对齐 context 与实际目录

预览并创建 context 中缺失的映射：

```powershell
node $forklift reconcile --context <context路径> --dry-run --json
node $forklift reconcile --context <context路径> --json
```

只有用户明确要求“以 context 为准清理多余 Forklift 映射”时才使用 `--prune`，而且必须先预览：

```powershell
node $forklift reconcile --context <context路径> --prune --dry-run --json
```

`--prune` 仍只处理中央仓库映射，不处理真实目录和外部链接。

## 删除中央 Skill

先查看将解除的映射：

```powershell
node $forklift remove <skill> --context <context路径> --dry-run --json
```

确认后才执行：

```powershell
node $forklift remove <skill> --context <context路径> --force --json
```

删除会同时扫描 context 与 Codex 配置中的已知项目，并按完整 TOML 语法识别 quoted key、inline table、dotted key 和 Unicode 转义。只要 Codex 配置不可读取、TOML 非法、项目离线、期望分配的映射根缺失或其他扫描无法安全完成，默认停止删除；其中可确认放弃扫描的不可用来源只有在用户查看预演后才追加 `--allow-unavailable`。

不要用文件系统命令绕过该保护流程。

## 报告

```powershell
node $forklift inventory --context <context路径> --json
node $forklift report --context <context路径> --json
```

HTML 必须是单文件、无网络依赖，并同时提供：

- Skill → 全局和项目的反向映射。
- 项目 → 实际和期望 Skill 的正向映射。
- 中央仓库数量、全局数量、项目分配数量。
- 缺失映射、配置外映射、真实目录冲突和未纳管全局 Skill。

## 安全边界

- 不读取或复制 Skill 目录中的符号链接，避免越界带入外部文件。
- 允许 `warehouse` 根目录本身是 Junction，但中央仓库的直接子 Skill 必须是实体目录。
- Skill 名称只接受小写字母、数字和连字符，并限制为 64 个字符。
- 不覆盖真实目录；需要迁移时使用 `adopt`。
- `warehouse` 与 `globalTarget` 不得相同、互相嵌套或指向用户目录/磁盘根目录。
- 项目 `skillsDir` 必须留在项目根目录内；如果现有 Junction 经解析后指向项目外部，停止写入。
- 不同项目的 Skills 根目录不得相同或互相嵌套，包括经父级 Junction 解析后指向同一位置的情况。
- context 经父级 Junction 或符号链接访问时统一解析到物理文件后加锁和写入；context 存在硬链接别名时拒绝修改。
- 报告不得写入中央仓库、Codex 全局 Skills 目录或已登记项目的 Skills 目录；盘符、UNC 和 Junction 等路径别名按文件身份识别，并使用临时文件和 rename 原子更新报告。
- 报告不得覆盖 context、context 锁文件、Codex 配置或任何已有硬链接目标。
- 不把插件缓存、`.system` 或其他 Agent 目录纳入 Codex 中央仓库，除非用户明确要求。
- 不把包含凭据的 Git URL 或 header 原样写入报告或 context；URL userinfo、全部 query/fragment 和敏感 header 值统一脱敏。
- 加载已有 context 时严格校验版本、必填字段和类型；未知版本或畸形数据必须停止，不能用默认值静默改写。
- 不在未预览的情况下运行 `remove --force`、`project-remove --force` 或 `reconcile --prune`。
- 任何冲突都停止当前变更，保留已有文件，并把可执行的下一步告诉用户。
- 修改命令使用 context 排他锁；删除先把映射和中央目录暂存，context 提交后再清理，并报告未清理完的 `cleanupPending`。
