import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, FileCheck2, Loader2, RefreshCw, Search, X } from "lucide-react";
import { cn } from "../utils";
import { getErrorMessage } from "../lib/error";
import {
  createSkillGovernanceLock,
  inspectSkillGovernance,
  verifySkillGovernanceLock,
  type GovernedSkill,
  type GovernanceIssue,
  type GovernanceReport,
  type GovernanceState,
} from "../lib/governance";

const STATE_LABELS: Record<GovernanceState, string> = {
  locked: "与基线一致",
  changed: "内容已变化",
  unlocked: "未纳入基线",
  missing: "文件已缺失",
  unreadable: "无法读取",
};

const STATE_COLORS: Record<GovernanceState, string> = {
  locked: "text-emerald-500 bg-emerald-500/10",
  changed: "text-amber-500 bg-amber-500/10",
  unlocked: "text-sky-500 bg-sky-500/10",
  missing: "text-red-500 bg-red-500/10",
  unreadable: "text-red-500 bg-red-500/10",
};

function IssueList({ issues }: { issues: GovernanceIssue[] }) {
  return (
    <ul className="space-y-2 text-[13px]">
      {issues.map((issue, index) => (
        <li key={`${issue.code}:${issue.path}:${index}`} className="flex items-start gap-2">
          <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[11px]", issue.severity === "error" ? "bg-red-500/10 text-red-500" : issue.severity === "warning" ? "bg-amber-500/10 text-amber-500" : "bg-surface-hover text-tertiary")}>
            {issue.severity === "error" ? "需修复" : issue.severity === "warning" ? "建议检查" : "提示"}
          </span>
          <div className="min-w-0">
            <p className="text-secondary break-words">{issue.message}</p>
            {issue.path && <p className="text-muted text-[11px] break-all mt-0.5">{issue.path}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SkillCard({ skill }: { skill: GovernedSkill }) {
  return (
    <article className="app-panel p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-primary break-words">{skill.name}</h2>
          <p className="text-xs text-muted break-all mt-1">{skill.relative_path}</p>
        </div>
        <span className={cn("rounded-full px-2.5 py-1 text-xs shrink-0", STATE_COLORS[skill.state])}>{STATE_LABELS[skill.state]}</span>
      </div>
      {skill.description && <p className="text-[13px] text-tertiary line-clamp-2">{skill.description}</p>}
      <div className="text-xs text-tertiary flex flex-wrap gap-x-5 gap-y-1">
        <span className="break-all">来源：{skill.source || "未记录来源"}</span>
        <span className="break-all">修订：{skill.revision || "未记录固定修订"}</span>
      </div>
      {skill.issues.length > 0 && <IssueList issues={skill.issues} />}
      <details className="border-t border-border-subtle pt-2 text-xs text-muted">
        <summary className="cursor-pointer hover:text-secondary">查看内容指纹</summary>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 mt-2">
          <dt>当前</dt><dd className="font-mono break-all">{skill.content_hash || "无法计算"}</dd>
          <dt>基线</dt><dd className="font-mono break-all">{skill.locked_hash || "尚未记录"}</dd>
        </dl>
      </details>
    </article>
  );
}

export function SkillGovernance() {
  const [report, setReport] = useState<GovernanceReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<GovernanceState | "all" | "issues">("all");
  const [confirming, setConfirming] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const baselineButtonRef = useRef<HTMLButtonElement>(null);
  const operationRef = useRef(false);

  useEffect(() => {
    let current = true;
    inspectSkillGovernance().then((value) => {
      if (current) setReport(value);
    }).catch((err: unknown) => {
      if (current) setError(getErrorMessage(err, "读取技能库失败，请重试。"));
    }).finally(() => {
      if (current) setBusy(false);
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (confirming && !dialog.open) dialog.showModal();
    else if (!confirming && dialog.open) {
      dialog.close();
      baselineButtonRef.current?.focus();
    }
  }, [confirming]);

  const counts = useMemo(() => {
    const states: Record<GovernanceState, number> = { locked: 0, changed: 0, unlocked: 0, missing: 0, unreadable: 0 };
    for (const skill of report?.skills ?? []) states[skill.state] += 1;
    const issues = [...(report?.issues ?? []), ...(report?.skills.flatMap((skill) => skill.issues) ?? [])];
    return { ...states, errors: issues.filter((issue) => issue.severity === "error").length, warnings: issues.filter((issue) => issue.severity === "warning").length };
  }, [report]);

  const visibleSkills = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (report?.skills ?? []).filter((skill) => {
      const matchesState = filter === "all" || (filter === "issues" ? skill.issues.some((issue) => issue.severity !== "info") : skill.state === filter);
      return matchesState && (!search || [skill.name, skill.relative_path, skill.description, skill.source].some((value) => value?.toLocaleLowerCase().includes(search)));
    });
  }, [report, query, filter]);

  async function run(action: "inspect" | "verify" | "prepare" | "lock") {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "lock" && !report) throw new Error("请先刷新扫描，再创建基线。");
      const next = await (action === "lock" && report ? createSkillGovernanceLock(report) : action === "verify" ? verifySkillGovernanceLock() : inspectSkillGovernance());
      setReport(next);
      if (action === "prepare") setConfirming(true);
      if (action === "lock") {
        setConfirming(false);
        setNotice(`已记录 ${next.locked_count} 个技能的版本基线。`);
      }
      if (action === "verify") {
        const differences = next.skills.filter((skill) => skill.state !== "locked").length;
        const errors = [...next.issues, ...next.skills.flatMap((skill) => skill.issues)].filter((issue) => issue.severity === "error").length;
        setNotice(!next.lock_exists ? "尚未创建基线，请先检查技能内容并创建。" : differences > 0 || errors > 0 ? `校验完成：${differences} 个技能与基线不同，${errors} 个问题需修复。` : "校验完成，技能内容与版本基线一致。");
      }
    } catch (err) {
      setError(getErrorMessage(err, "操作未完成，请重试。"));
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  }

  const canCreate = !!report && (report.lock_exists || report.skills.length > 0) && counts.errors === 0 && counts.unreadable === 0;

  return (
    <div className="app-page">
      <header className="app-page-header">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="app-page-title">技能治理</h1>
            <p className="app-page-subtitle text-tertiary">检查标准兼容性，记录版本基线，发现技能内容的变化。</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button className="app-button-secondary focus-visible:ring-2 focus-visible:ring-accent" onClick={() => void run("inspect")} disabled={busy}>
              <RefreshCw className={cn("w-4 h-4", busy && "animate-spin")} />刷新扫描
            </button>
            <button className="app-button-secondary focus-visible:ring-2 focus-visible:ring-accent" onClick={() => void run("verify")} disabled={busy || !report?.lock_exists}>
              <FileCheck2 className="w-4 h-4" />校验基线
            </button>
            <button ref={baselineButtonRef} className="app-button-primary focus-visible:ring-2 focus-visible:ring-accent" onClick={() => void run("prepare")} disabled={busy || !canCreate}>
              {report?.lock_exists ? "更新基线" : "创建基线"}
            </button>
          </div>
        </div>
      </header>

      {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-[13px] text-red-500 break-words">{error}</div>}
      {notice && <p role="status" className="rounded-lg border border-border-subtle bg-surface p-3 text-[13px] text-secondary">{notice}</p>}

      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "与基线一致", value: counts.locked, color: "text-emerald-500" },
          { label: "变化或缺失", value: counts.changed + counts.missing + counts.unreadable, color: "text-amber-500" },
          { label: "未纳入基线", value: counts.unlocked, color: "text-sky-500" },
          { label: "需修复 / 建议检查", value: `${counts.errors} / ${counts.warnings}`, color: "text-primary" },
        ].map((item) => <div key={item.label} className="app-panel p-4"><p className="text-xs text-tertiary mb-2">{item.label}</p><p className={cn("text-2xl font-semibold", item.color)}>{busy && !report ? "—" : item.value}</p></div>)}
      </div>

      <section className="app-panel p-4 space-y-2 text-[13px]">
        <div className="flex flex-wrap justify-between gap-2">
          <p className="font-medium text-secondary">{report?.lock_exists ? `基线已记录 ${report.locked_count} 个技能` : "检查完成后，将当前内容保存为可校验的基线"}</p>
          <nav aria-label="技能管理相关页面" className="flex gap-4 text-accent-light">
            <Link to="/install" className="hover:underline">安装技能</Link><Link to="/my-skills" className="hover:underline">技能库</Link><Link to="/global-workspace" className="hover:underline">全局分配</Link>
          </nav>
        </div>
        <p className="text-tertiary">基线用于比对本地文件，不代表上游版本最新，也不评估技能执行是否安全。更新技能后，先检查变化，再更新基线。</p>
        {report && <details className="text-xs text-muted"><summary className="cursor-pointer">查看仓库与基线位置</summary><p className="break-all mt-2">仓库：{report.root}</p><p className="break-all mt-1">基线：{report.lock_path}</p></details>}
        {report && !canCreate && report.skills.length > 0 && <p className="text-amber-500">请先处理读取失败或“需修复”问题，再创建版本基线。</p>}
      </section>

      {!!report?.issues.length && <section className="app-panel p-4 space-y-3"><h2 className="text-sm font-medium text-primary flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-500" />仓库检查</h2><IssueList issues={report.issues} /></section>}

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索技能" placeholder="搜索名称、路径或来源" className="w-full rounded-md border border-border bg-surface py-2 pl-9 pr-3 text-[13px] text-primary outline-none focus:border-accent" />
        </div>
        <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} aria-label="筛选技能状态" className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-secondary">
          <option value="all">全部状态</option><option value="issues">有检查问题</option>
          {Object.entries(STATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span className="text-xs text-muted">{visibleSkills.length} / {report?.skills.length ?? 0}</span>
      </div>

      {busy && !report ? <div role="status" className="py-16 flex items-center justify-center gap-2 text-tertiary"><Loader2 className="w-5 h-5 animate-spin" />正在检查技能库…</div> : !report ? <div className="app-panel py-12 text-center text-tertiary">尚未取得检查结果。点击“刷新扫描”重试。</div> : visibleSkills.length === 0 ? <div className="app-panel py-12 text-center text-tertiary"><CheckCircle2 className="w-7 h-7 mx-auto mb-3 text-muted" /><p>{report.skills.length === 0 ? "技能库中尚未发现技能，安装后即可开始检查。" : "没有符合当前筛选条件的技能。"}</p></div> : <div className="grid grid-cols-1 xl:grid-cols-2 gap-3" aria-busy={busy}>{visibleSkills.map((skill) => <SkillCard key={skill.relative_path} skill={skill} />)}</div>}

      <dialog ref={dialogRef} onCancel={(event) => { event.preventDefault(); if (!busy) setConfirming(false); }} aria-labelledby="governance-confirm-title" aria-describedby="governance-confirm-description" className="w-[460px] max-w-[90vw] rounded-xl border border-border bg-surface p-5 text-primary shadow-2xl backdrop:bg-black/60">
        <div className="flex items-center justify-between mb-4"><h2 id="governance-confirm-title" className="font-semibold">{report?.lock_exists ? "确认更新版本基线" : "确认创建版本基线"}</h2><button aria-label="关闭确认" onClick={() => setConfirming(false)} disabled={busy} className="text-muted hover:text-primary"><X className="w-4 h-4" /></button></div>
        <p id="governance-confirm-description" className="text-[13px] text-tertiary leading-relaxed">本次将记录扫描到的当前内容。之后的校验将与这次记录比较；更新基线会接受下列内容变化。</p>
        <div className="flex flex-wrap gap-2 my-4 text-xs">{[`新增 ${counts.unlocked}`, `变化 ${counts.changed}`, `移除 ${counts.missing}`, `保持 ${counts.locked}`].map((label) => <span key={label} className="rounded-full bg-surface-hover px-3 py-1.5">{label}</span>)}</div>
        {!canCreate && <p className="text-[13px] text-amber-500 mb-4">最新扫描发现需修复问题，请关闭后处理。</p>}
        {error && <p role="alert" className="text-[13px] text-red-500 break-words mb-4">{error}</p>}
        <div className="flex justify-end gap-2"><button autoFocus onClick={() => setConfirming(false)} disabled={busy} className="app-button-secondary focus-visible:ring-2 focus-visible:ring-accent">取消</button><button onClick={() => void run("lock")} disabled={busy || !canCreate} className="app-button-primary focus-visible:ring-2 focus-visible:ring-accent">{busy ? "正在记录…" : "确认记录当前版本"}</button></div>
      </dialog>
    </div>
  );
}
