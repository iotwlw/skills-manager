# Skill 管理生态调研与升级依据

调研日期：2026-11-09（北京时间）。文档归档在现有 `docs/` 文档区，与既有格式检测规范并列。

## 结论与口径

本次覆盖有公开证据的主要管理路径：开放标准、原生宿主、命令行分发、声明式清单、桌面管理、技能组合与质量评估。生态持续变化，无法证明穷尽“所有”方案，也没有证据支持某个框架在所有场景中最好。

**本项目的选型判断**：继续使用 Tauri、React 与本机中央仓库，将重点放在来源、完整性、实际状态、项目分配和生态互通。中央实体配链接的做法仍与主流方向一致；升级管理模型比更换界面框架更有直接价值。

下表“已核实事实”来自官方文档或项目自身仓库；“本项目判断”是结合 Windows 本机管理场景作出的推论，不是来源的承诺。功能描述不代表本次已经安装、实测或集成了对应产品。

## 主要方案比较

| 方案 | 已核实事实 | 本项目判断 |
| --- | --- | --- |
| [Agent Skills 标准](https://agentskills.io/specification) | `SKILL.md` 包含 YAML 元数据与正文；必需名称和描述；支持脚本、参考资料、资源和渐进加载；提供参考验证器。 | 作为兼容与格式诊断基础。内容格式规范不等于统一包管理、锁文件或部署标准。 |
| [Vercel skills](https://github.com/vercel-labs/skills/blob/main/docs/commands.md) | 支持 Git、下载和本地来源、指定版本引用、项目与全局范围、中央副本配链接或复制、更新检查及锁文件恢复；冻结恢复校验内容摘要。 | 借鉴声明式恢复、来源与版本记录。恢复和更新必须区分；生态导入应明确格式版本。 |
| [skills.sh](https://www.skills.sh/docs/faq) 与 [Packs](https://www.skills.sh/docs/packs) | 榜单使用 CLI 汇总安装遥测；技能包可组合公开、私有及仓库来源。 | 作为发现和分享来源。安装量不是质量、活跃使用或安全证明。 |
| [Claude 插件](https://code.claude.com/docs/en/plugins) 与[市场](https://code.claude.com/docs/en/plugin-marketplaces) | 插件将技能、子代理、钩子、MCP 等组件作为整体加载；市场通过 `.claude-plugin/marketplace.json` 描述来源。 | 插件应保留组件边界，不能把内部技能单独接管后假设其依赖仍然完整。 |
| [OpenAI 技能](https://learn.chatgpt.com/docs/customization/overview#skills) 与[插件结构](https://developers.openai.com/plugins/build/plugins#plugin-structure) | 当前官方说明包含项目 `.agents/skills` 与用户 `~/.agents/skills`；可移植插件以根目录 `plugin.json`、`skills/`、`mcp.json` 组织，并兼容旧 `.codex-plugin` 布局。 | 新路径应可识别；已有 `.codex/skills` 部署需要兼容，不应未经迁移检查整体替换。插件路径与裸技能路径应分别识别。 |
| [OpenSkills](https://github.com/numman-ali/openskills) | 可把技能索引同步到 `AGENTS.md`，通过命令按需读取正文；默认项目安装，支持本地与私有仓库。 | 适合缺乏原生发现机制的宿主。原生支持技能的宿主需避免重复索引。其 `.agent/skills` 路径与 `.agents/skills` 不同。 |
| [pi0/skillman](https://github.com/pi0/skillman) | 从 `skills.json` 声明来源与技能，底层调用 Vercel skills；公开[配置结构](https://github.com/pi0/skillman/blob/main/skills_schema.json)。 | 适合借鉴轻量清单。项目标题中的“锁定”不能直接证明存在完整内容锁与不可变版本保证。 |
| [haolin29/skillman](https://github.com/haolin29/skillman) | 支持多宿主、Git 引用、版本记录、预演和链接转实体；无显式版本时使用内容 MD5 标识。 | 可借鉴安装记录与预演；本项目的完整性校验应覆盖整个技能目录，不能只看入口文件或声明版本。 |
| [Skills Manager 上游](https://github.com/xingkongliang/skills-manager) | 中央库、多个宿主、实际目录视图、项目工作区、预设及链接/复制分发；预设应用是一次性操作而非持续同步。 | 与本项目基础最接近。优先补齐诊断和复现能力；必须让用户看清预设、期望分配与实际目录的区别。 |
| [ASM](https://github.com/luongnv89/asm) | 跨宿主清单、重复和重叠审计、描述/正文分别估算上下文成本；区分收藏、激活、停用与一次性读取。 | 借鉴健康中心与按需启用。估算需注明，不应把静态扫描或格式通过显示为安全认证。 |
| [SkillKit](https://github.com/rohitg00/skillkit) | 多宿主转换、项目清单、运行时发现、推荐及 REST/MCP 接口，另有生成与记忆能力。 | 借鉴适配层和互通；生成、记忆、跨机器网络并非本次本机管理升级的必要条件。 |
| [Superpowers](https://github.com/obra/superpowers) | 面向软件开发的技能工作流与多宿主插件。 | 它是流程内容与组合产品，不是本机技能管理底座；可作为组合来源，不宜直接替代管理器。 |
| [官方技能评估](https://agentskills.io/skill-creation/evaluating-skills) | 用真实输入、预期结果及有/无技能的对照评估迭代质量。 | 应区分格式有效、内容一致和运行效果已评估；发现评估文件不等于评估通过。 |

## 热度证据及限制

下表来自本次打开的 GitHub 仓库页面快照，页面可能存在缓存与四舍五入；星标是关注度，不能代表活跃用户数。不同类别不宜直接排名。

| 项目 | 页面星标约数 | 类别 |
| --- | ---: | --- |
| [Superpowers](https://github.com/obra/superpowers) | 314.8k | 工作流与技能内容 |
| [Anthropic skills](https://github.com/anthropics/skills) | 190.1k | 官方技能内容 |
| [Vercel skills](https://github.com/vercel-labs/skills) | 38.7k | 安装与分发工具 |
| [OpenSkills](https://github.com/numman-ali/openskills) | 10.8k | 兼容加载器 |
| [Skills Manager](https://github.com/xingkongliang/skills-manager) | 7.4k | 桌面管理器 |
| [SkillKit](https://github.com/rohitg00/skillkit) | 1.6k | 综合工具集 |
| [ASM](https://github.com/luongnv89/asm) | 968 | 清单与治理工具 |
| [pi0/skillman](https://github.com/pi0/skillman) | 190 | 声明式清单包装器 |

较小项目仍可能提供有价值的设计，但不据此称其为“最火”。本次未通过独立数据核实月活、真实调用次数或生产可靠性。

## 对当前系统的升级建议

以下是架构建议，不是实现完成声明；最终交付应以代码、运行结果及验证记录为准。

1. **统一身份与来源**：区分技能名称、来源路径、期望引用、实际提交、全目录摘要及分配目标；浮动分支不能显示为不可变版本。
2. **意图与实际状态分开**：配置表达期望，扫描表达实际；分别呈现缺失、外部技能、损坏链接、内容改动与冲突。
3. **可复现的项目清单**：支持明确版本的导入/导出，保留来源与摘要；外部锁文件只能按其格式承诺解释，不冒称为统一官方标准。
4. **变更可预览、结果可追踪**：新增、更新、解除分配分别显示；应用时重新核验目标状态，避免过期预览覆盖新修改；失败保留可恢复信息。
5. **健康诊断可解释**：诊断名称、描述、资源大小、链接边界、内容重复和估算上下文成本；问题给出原因，不自动清除未知内容。
6. **收藏与启用分开**：中央库容纳收藏，项目按需分配；全局启用须有明确意图；同名不同来源冲突可见。
7. **保留轻量本机架构**：界面调用拥有状态的管理层，避免界面、CLI 和外部安装器各自维护互不一致的分配记录。

## 相比旧认知的更新

Vercel 当前[命令文档](https://github.com/vercel-labs/skills/blob/main/docs/commands.md)已包含无来源参数的 `skills install` / `skills i` 恢复别名，以及 CI 默认的冻结锁文件行为；已有中央目录默认保留，强制重装另选。不能再将该方案描述为“仅能安装和更新、缺乏恢复”。

Claude 当前[技能文档](https://code.claude.com/docs/en/skills)已区分插件评估和单技能创作评估，两者数据格式不可互换。管理器若接入结果，应保留评估类型、工具版本和证据，而不是仅检查是否存在某个同名文件。
