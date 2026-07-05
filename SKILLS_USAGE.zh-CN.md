# 项目 Skills 使用说明

本项目已通过 `skills` CLI 安装 3 个项目级 skill，安装记录保存在 `skills-lock.json`，实际 skill 文件位于 `.agents/skills/`。

## 已安装的 Skill

| Skill | 来源 | 用途 |
| --- | --- | --- |
| `find-skills` | `vercel-labs/skills` | 在开放 agent skills 生态中查找、对比和安装可用 skill。 |
| `search-skill` | `gbsoss/skill-from-masters` | 从可信 marketplace 和 curated 列表中搜索并推荐 Claude Code / agent skills。 |
| `skill-from-github` | `gbsoss/skill-from-masters` | 先搜索高质量 GitHub 项目，再深入理解项目做法，并把知识沉淀成新的 skill。 |

## 什么时候使用

### `find-skills`

适合泛化的 skill 查找场景，例如：

```text
帮我找一个可以做前端设计审查的 skill
有没有能自动生成 changelog 的 skill
找一个适合 Playwright 测试的 agent skill
```

它会优先使用 `skills.sh` 和 `npx skills find` 搜索生态内已有 skill，并在推荐前检查安装量、来源和仓库可信度。

### `search-skill`

适合需要更严格筛选来源的 skill 搜索场景，例如：

```text
用 search-skill 帮我找可信的浏览器自动化 skill
搜索能做安全审计的 Claude Code skill
从官方或 curated marketplace 里找一个文档处理 skill
```

它的默认策略是先查官方或高信任来源，再查社区 curated 列表和 marketplace，并过滤低星、长期不维护、缺少 `SKILL.md` 或存在可疑代码模式的结果。

### `skill-from-github`

适合“先学习优秀开源项目，再创建新 skill”的场景，例如：

```text
用 skill-from-github 学习几个优秀的 markdown 转 PDF 项目，然后帮我设计一个 skill
我想做一个 API 文档生成 skill，先从 GitHub 找成熟项目参考
研究一下高质量 sentiment analysis 项目，把方法沉淀成可复用 skill
```

它会按任务关键词搜索 GitHub，优先选择 star 数高、最近 12 个月仍维护、README 清晰且有实际代码的项目。进入深度分析和创建 skill 前，应先让用户确认候选项目和总结方向。

## 本地命令

查看项目已安装 skill：

```bash
npx skills ls --json
```

按关键词搜索可安装 skill：

```bash
npx skills find "browser automation"
```

安装新的项目级 skill：

```bash
npx skills add owner/repo@skill-name -y
```

更新项目已安装 skill：

```bash
npx skills update -p -y
```

从锁文件恢复项目 skill：

```bash
npx skills experimental_install
```

## 维护约定

- 修改或新增项目级 skill 后，提交 `.agents/skills/` 和 `skills-lock.json`。
- 安装外部 skill 后先阅读对应 `SKILL.md`，确认它没有要求访问敏感路径、读取密钥、执行动态代码或修改系统文件。
- 对搜索类 skill 的结果保持审查：优先选择官方、高安装量、高 star、近期维护的来源。
- `skill-from-github` 用于学习和抽象方法，不应直接把第三方项目代码复制进新 skill；如引用项目经验，应保留来源和许可证信息。
