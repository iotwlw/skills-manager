#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { parse: parseToml } = require("./vendor/smol-toml.cjs");

const CONTEXT_VERSION = 1;
const DEFAULT_CONTEXT_FILE = "skill-forklift.context.json";
const DEFAULT_WAREHOUSE = "~/.skills-manager/skills";
const DEFAULT_GLOBAL_TARGET = "~/.codex/skills";
const DEFAULT_CODEX_CONFIG = "~/.codex/config.toml";
const DEFAULT_REPORT = "./skill-forklift-report.html";
const DEFAULT_PROJECT_SKILLS_DIR = ".codex/skills";
const SKILL_MANIFESTS = ["SKILL.md", "skill.md"];
const SKIP_COPY_NAMES = new Set([".git", "node_modules", ".DS_Store"]);
const INTERNAL_ENTRY_PREFIX = ".forklift-";
const CONTEXT_LOCK_SUFFIX = ".forklift.lock";
const CONTEXT_LOCK_WAIT_MS = 5_000;
const MALFORMED_LOCK_GRACE_MS = 30_000;
const BOOLEAN_OPTIONS = new Set([
  "allowMissing",
  "allowUnavailable",
  "dryRun",
  "force",
  "help",
  "json",
  "prune",
]);
const VALUE_OPTIONS = new Set([
  "branch",
  "codexConfig",
  "context",
  "globalTarget",
  "id",
  "name",
  "output",
  "path",
  "project",
  "report",
  "scope",
  "skill",
  "skillsDir",
  "source",
  "subpath",
  "warehouse",
]);
const COMMAND_OPTIONS = {
  help: ["help", "json"],
  init: ["codexConfig", "context", "force", "globalTarget", "help", "json", "report", "warehouse"],
  inventory: ["context", "help", "json"],
  report: ["context", "dryRun", "help", "json", "output"],
  "discover-projects": ["context", "dryRun", "help", "json"],
  "project-add": ["allowMissing", "context", "dryRun", "help", "id", "json", "name", "path", "skillsDir"],
  "project-remove": [
    "allowUnavailable",
    "context",
    "dryRun",
    "force",
    "help",
    "json",
    "project",
  ],
  assign: ["context", "dryRun", "help", "json", "project", "scope", "skill"],
  unassign: ["context", "dryRun", "help", "json", "project", "scope", "skill"],
  reconcile: ["context", "dryRun", "help", "json", "prune"],
  install: ["branch", "context", "dryRun", "force", "help", "json", "name", "project", "scope", "source", "subpath"],
  adopt: ["branch", "context", "dryRun", "force", "help", "json", "name", "project", "scope", "source", "subpath"],
  remove: ["allowUnavailable", "context", "dryRun", "force", "help", "json", "skill"],
};
const POSITIONAL_LIMITS = {
  help: 0,
  init: 0,
  inventory: 0,
  report: 0,
  "discover-projects": 0,
  "project-add": 0,
  "project-remove": 0,
  assign: 1,
  unassign: 1,
  reconcile: 0,
  install: 1,
  adopt: 1,
  remove: 1,
};

class ForkliftError extends Error {
  constructor(message, code = "forklift_error", details = undefined) {
    super(message);
    this.name = "ForkliftError";
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const rest = command === "help" && argv[0]?.startsWith("-") ? argv : argv.slice(1);
  const options = {};
  const positionals = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--") continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const equalsIndex = raw.indexOf("=");
    let key;
    let value;
    if (equalsIndex >= 0) {
      key = raw.slice(0, equalsIndex);
      value = raw.slice(equalsIndex + 1);
    } else {
      key = raw;
      const next = rest[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }

    const normalized = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[normalized] = value;
  }

  return { command, options, positionals };
}

function validateCommandLine(command, options, positionals) {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) throw new ForkliftError(`未知命令：${command}`, "unknown_command");
  const allowedSet = new Set(allowed);
  for (const key of BOOLEAN_OPTIONS) {
    if (!(key in options)) continue;
    const value = options[key];
    if (value === true || value === false) continue;
    if (String(value).toLowerCase() === "true") options[key] = true;
    else if (String(value).toLowerCase() === "false") options[key] = false;
    else {
      throw new ForkliftError(`--${key} 只接受 true 或 false`, "invalid_boolean_option", {
        option: key,
        value,
      });
    }
  }
  for (const key of Object.keys(options)) {
    if (!allowedSet.has(key)) {
      throw new ForkliftError(`命令 ${command} 不支持参数 --${key}`, "unknown_option", {
        command,
        option: key,
      });
    }
  }
  for (const key of VALUE_OPTIONS) {
    if (!(key in options)) continue;
    if (options[key] === true || options[key] === false || String(options[key]).trim() === "") {
      throw new ForkliftError(`--${key} 缺少值`, "missing_option_value", { option: key });
    }
  }
  const limit = POSITIONAL_LIMITS[command] ?? 0;
  if (positionals.length > limit) {
    throw new ForkliftError(
      `命令 ${command} 最多接受 ${limit} 个位置参数，实际收到 ${positionals.length} 个`,
      "too_many_positionals",
    );
  }
}

function uniqueSorted(values) {
  return [...new Set((values ?? []).filter(Boolean).map(String))].sort((a, b) =>
    a.localeCompare(b, "zh-CN"),
  );
}

function slugify(value) {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

function shortHash(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 7);
}

function stripWindowsVerbatimPrefix(value) {
  const raw = String(value);
  if (raw.startsWith("\\\\?\\UNC\\")) return `\\\\${raw.slice(8)}`;
  if (raw.startsWith("\\\\?\\")) return raw.slice(4);
  return raw;
}

function normalizeForCompare(value) {
  const normalized = path
    .resolve(stripWindowsVerbatimPrefix(value))
    .replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative) return true;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function statExistingPath(candidate) {
  try {
    return await fsp.stat(candidate);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

async function isPathInsideByIdentity(child, parent) {
  if (isPathInside(child, parent)) return true;
  const parentStat = await statExistingPath(parent);
  if (!parentStat) return false;

  let current = path.resolve(child);
  let currentStat = null;
  while (!currentStat) {
    currentStat = await statExistingPath(current);
    if (currentStat) break;
    const next = path.dirname(current);
    if (samePath(next, current)) return false;
    current = next;
  }

  while (true) {
    if (sameFileIdentity(currentStat, parentStat)) return true;
    const next = path.dirname(current);
    if (samePath(next, current)) return false;
    current = next;
    currentStat = await fsp.stat(current);
  }
}

async function pathsOverlapByIdentity(left, right) {
  return (
    (await isPathInsideByIdentity(left, right)) ||
    (await isPathInsideByIdentity(right, left))
  );
}

function expandPathVariables(value) {
  if (typeof value !== "string") {
    throw new ForkliftError("路径必须是字符串", "invalid_path", { value });
  }
  const home = os.homedir();
  return value
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/\$\{HOME\}|\$\{USERPROFILE\}|%USERPROFILE%/gi, home);
}

function resolveConfiguredPath(value, contextPath) {
  const expanded = expandPathVariables(value);
  if (path.isAbsolute(expanded)) return path.normalize(stripWindowsVerbatimPrefix(expanded));
  return path.resolve(path.dirname(contextPath), stripWindowsVerbatimPrefix(expanded));
}

function resolveContextPath(options = {}) {
  const configured = options.context || process.env.SKILL_FORKLIFT_CONTEXT;
  if (configured) return path.resolve(expandPathVariables(String(configured)));

  let current = path.resolve(process.cwd());
  while (true) {
    const candidate = path.join(current, DEFAULT_CONTEXT_FILE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const homeContext = path.join(os.homedir(), ".skill-forklift", "context.json");
  if (fs.existsSync(homeContext)) return homeContext;
  return path.resolve(DEFAULT_CONTEXT_FILE);
}

function cloneContext(context) {
  return JSON.parse(JSON.stringify(context));
}

function validateProjectSkillsDir(value, label = "skillsDir") {
  const skillsDir = String(value ?? "");
  const slashNormalized = skillsDir.replaceAll("\\", "/");
  const normalized = path.posix.normalize(slashNormalized);
  if (
    !skillsDir.trim() ||
    path.isAbsolute(skillsDir) ||
    path.win32.isAbsolute(skillsDir) ||
    path.posix.isAbsolute(skillsDir) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    /^(?:~|\$\{|%USERPROFILE%)/i.test(skillsDir)
  ) {
    throw new ForkliftError(
      `${label} 必须是项目内的相对子目录：${skillsDir}`,
      "invalid_project_skills_dir",
    );
  }
  return skillsDir;
}

function assertStringField(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ForkliftError(`${label} 必须是非空字符串`, "invalid_context");
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ForkliftError(`${label} 必须是字符串数组`, "invalid_context");
  }
}

function validateContextShape(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ForkliftError("context 顶层必须是对象", "invalid_context");
  }
  if (raw.version !== CONTEXT_VERSION) {
    throw new ForkliftError(
      `不支持 context version=${String(raw.version)}，当前仅支持 ${CONTEXT_VERSION}`,
      "unsupported_context_version",
    );
  }
  for (const field of ["warehouse", "globalTarget", "codexConfig", "reportPath"]) {
    assertStringField(raw[field], field);
  }
  assertStringArray(raw.globalSkills, "globalSkills");
  if (!Array.isArray(raw.projects)) {
    throw new ForkliftError("projects 必须是数组", "invalid_context");
  }
  if (
    raw.catalog !== undefined &&
    (!raw.catalog || typeof raw.catalog !== "object" || Array.isArray(raw.catalog))
  ) {
    throw new ForkliftError("catalog 必须是对象", "invalid_context");
  }

  const seenIds = new Set();
  raw.projects.forEach((project, index) => {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new ForkliftError(`projects[${index}] 必须是对象`, "invalid_context");
    }
    for (const field of ["id", "name", "path", "skillsDir"]) {
      assertStringField(project[field], `projects[${index}].${field}`);
    }
    assertStringArray(project.skills, `projects[${index}].skills`);
    if (seenIds.has(project.id)) {
      throw new ForkliftError(`项目 ID 重复：${project.id}`, "invalid_context");
    }
    seenIds.add(project.id);
  });
  for (const [name, entry] of Object.entries(raw.catalog ?? {})) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ForkliftError(`catalog.${name} 必须是对象`, "invalid_context");
    }
  }
}

function normalizeContext(raw) {
  validateContextShape(raw);
  const projects = raw.projects;
  const seenIds = new Set();
  const normalizedProjects = projects.map((project, index) => {
    const name = project.name;
    const skillsDir = validateProjectSkillsDir(
      project.skillsDir,
      `projects[${index}].skillsDir`,
    );
    const id = project.id;
    seenIds.add(id);
    return {
      ...project,
      id,
      name,
      path: project.path,
      skillsDir,
      skills: uniqueSorted(project.skills),
    };
  });

  const rawCatalog = raw.catalog ?? {};
  const catalog = Object.fromEntries(
    Object.entries(rawCatalog).map(([name, entry]) => {
      const value = entry && typeof entry === "object" ? entry : {};
      return [
        name,
        {
          ...value,
          source: value.source == null ? null : redactSource(value.source),
        },
      ];
    }),
  );
  return {
    ...raw,
    version: raw.version,
    warehouse: raw.warehouse,
    globalTarget: raw.globalTarget,
    codexConfig: raw.codexConfig,
    reportPath: raw.reportPath,
    globalSkills: uniqueSorted(raw.globalSkills),
    projects: normalizedProjects,
    catalog,
  };
}

function validateContext(context) {
  if (context.version !== CONTEXT_VERSION) {
    throw new ForkliftError(
      `不支持 context version=${context.version}，当前仅支持 ${CONTEXT_VERSION}`,
      "unsupported_context_version",
    );
  }
  for (const skill of context.globalSkills) validateSkillName(skill);
  for (const project of context.projects) {
    for (const skill of project.skills) validateSkillName(skill);
  }
}

async function loadContext(contextPath) {
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(contextPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ForkliftError(
        `找不到 context：${contextPath}。请先运行 init。`,
        "context_not_found",
      );
    }
    if (error instanceof SyntaxError) {
      throw new ForkliftError(`context JSON 无法解析：${error.message}`, "invalid_context_json");
    }
    throw error;
  }
  const context = normalizeContext(raw);
  validateContext(context);
  return context;
}

async function writeTextAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fsp.writeFile(temporary, content, "utf8");
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeContextAtomic(filePath, value) {
  try {
    const entryStat = await fsp.lstat(filePath);
    if (entryStat.isSymbolicLink()) {
      throw new ForkliftError(
        `context 提交路径不能在锁定后变成符号链接：${filePath}`,
        "unsafe_context_link",
      );
    }
    const fileStat = await fsp.stat(filePath);
    if (fileStat.nlink > 1) {
      throw new ForkliftError(
        `context 存在硬链接别名，拒绝原子替换：${filePath}`,
        "unsafe_context_hardlink",
        { links: fileStat.nlink },
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const normalized = normalizeContext(value);
  validateContext(normalized);
  await writeJsonAtomic(filePath, normalized);
  return normalized;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function contextLockPath(contextPath) {
  return `${contextPath}${CONTEXT_LOCK_SUFFIX}`;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function removeMalformedContextLock(lockPath) {
  let before;
  try {
    before = await fsp.stat(lockPath);
  } catch (error) {
    return error.code === "ENOENT";
  }
  if (Date.now() - before.mtimeMs < MALFORMED_LOCK_GRACE_MS) return false;
  try {
    const after = await fsp.stat(lockPath);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      return false;
    }
    await fsp.rm(lockPath, { force: false });
    return true;
  } catch {
    return false;
  }
}

async function removeAbandonedContextLock(lockPath) {
  let payload;
  try {
    payload = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  } catch {
    return removeMalformedContextLock(lockPath);
  }
  if (
    typeof payload.token !== "string" ||
    typeof payload.hostname !== "string" ||
    !Number.isInteger(Number(payload.pid))
  ) {
    return removeMalformedContextLock(lockPath);
  }
  if (payload.hostname !== os.hostname() || isProcessAlive(Number(payload.pid))) return false;
  try {
    const current = JSON.parse(await fsp.readFile(lockPath, "utf8"));
    if (current.token !== payload.token) return false;
    await fsp.rm(lockPath, { force: false });
    return true;
  } catch {
    return false;
  }
}

async function tryCreateContextLock(lockPath, payload) {
  const candidate = `${lockPath}.candidate-${process.pid}-${randomUUID()}`;
  const handle = await fsp.open(candidate, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.rm(candidate, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    try {
      await fsp.link(candidate, lockPath);
    } catch (error) {
      if (error.code === "EEXIST") return false;
      if (!["EPERM", "ENOSYS", "ENOTSUP", "EXDEV"].includes(error.code)) throw error;
      try {
        await fsp.copyFile(candidate, lockPath, fs.constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (copyError.code === "EEXIST") return false;
        throw copyError;
      }
    }
    return true;
  } finally {
    await fsp.rm(candidate, { force: true }).catch(() => {});
  }
}

async function acquireContextLock(contextPath, { waitMs = CONTEXT_LOCK_WAIT_MS } = {}) {
  const lockPath = contextLockPath(contextPath);
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  while (true) {
    const acquired = await tryCreateContextLock(lockPath, {
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
      token,
    });
    if (acquired) {
      return async () => {
        try {
          const current = JSON.parse(await fsp.readFile(lockPath, "utf8"));
          if (current.token === token) await fsp.rm(lockPath, { force: false });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    }
    if (await removeAbandonedContextLock(lockPath)) continue;
    if (Date.now() >= deadline) {
      throw new ForkliftError(
        `context 正被另一个 Forklift 进程使用：${lockPath}`,
        "context_locked",
        { lockPath },
      );
    }
    await sleep(50);
  }
}

function resolvedContextPaths(context, contextPath) {
  const resolved = {
    warehouse: resolveConfiguredPath(context.warehouse, contextPath),
    globalTarget: resolveConfiguredPath(context.globalTarget, contextPath),
    codexConfig: resolveConfiguredPath(context.codexConfig, contextPath),
    reportPath: resolveConfiguredPath(context.reportPath, contextPath),
  };
  for (const [label, root] of [
    ["warehouse", resolved.warehouse],
    ["globalTarget", resolved.globalTarget],
  ]) {
    if (samePath(root, os.homedir()) || samePath(root, path.parse(root).root)) {
      throw new ForkliftError(
        `${label} 不能指向用户目录或磁盘根目录：${root}`,
        "unsafe_configured_root",
      );
    }
  }
  if (
    samePath(resolved.warehouse, resolved.globalTarget) ||
    isPathInside(resolved.warehouse, resolved.globalTarget) ||
    isPathInside(resolved.globalTarget, resolved.warehouse)
  ) {
    throw new ForkliftError(
      "warehouse 与 globalTarget 必须是互不嵌套的独立目录",
      "overlapping_configured_roots",
    );
  }
  if (
    isPathInside(resolved.reportPath, resolved.warehouse) ||
    isPathInside(resolved.reportPath, resolved.globalTarget)
  ) {
    throw new ForkliftError(
      "reportPath 不能写入中央仓库或 Codex 全局 Skills 目录",
      "unsafe_report_path",
    );
  }
  return resolved;
}

async function pathExists(value) {
  try {
    await fsp.lstat(value);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function manifestPath(skillDir) {
  for (const manifest of SKILL_MANIFESTS) {
    const candidate = path.join(skillDir, manifest);
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

async function isSkillDirectory(skillDir) {
  return Boolean(await manifestPath(skillDir));
}

function stripYamlScalar(raw) {
  const value = String(raw ?? "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readFrontmatterField(yaml, key) {
  const lines = yaml.split(/\r?\n/);
  const matcher = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:\\s*(.*)$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(matcher);
    if (!match) continue;
    const rawValue = match[1].trim();
    if (rawValue !== "|" && rawValue !== ">" && rawValue !== "|-" && rawValue !== ">-") {
      return stripYamlScalar(rawValue);
    }
    const block = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line && !/^\s/.test(line)) break;
      block.push(line.replace(/^\s{2,}/, ""));
    }
    const joined = rawValue.startsWith(">") ? block.join(" ") : block.join("\n");
    return joined.trim();
  }
  return "";
}

async function readSkillMetadata(skillDir) {
  const manifest = await manifestPath(skillDir);
  if (!manifest) {
    throw new ForkliftError(`不是有效 Skill 目录：${skillDir}`, "invalid_skill_directory");
  }
  const content = await fsp.readFile(manifest, "utf8");
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const yaml = frontmatter?.[1] ?? "";
  return {
    name: readFrontmatterField(yaml, "name") || path.basename(skillDir),
    description: readFrontmatterField(yaml, "description"),
    manifest: path.basename(manifest),
  };
}

function validateSkillName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new ForkliftError("Skill 名称不能为空", "invalid_skill_name");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new ForkliftError(`非法 Skill 名称：${name}`, "invalid_skill_name");
  }
  return name.trim();
}

async function directorySize(root) {
  let total = 0;
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_COPY_NAMES.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    const stat = await fsp.lstat(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) total += await directorySize(fullPath);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

async function listWarehouseSkills(warehouse, catalog = {}) {
  if (!(await pathExists(warehouse))) return [];
  const entries = await fsp.readdir(warehouse, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillPath = path.join(warehouse, entry.name);
    let metadata;
    try {
      metadata = await readSkillMetadata(skillPath);
    } catch {
      continue;
    }
    let sizeBytes = 0;
    try {
      sizeBytes = await directorySize(skillPath);
    } catch {
      // 报告不应因单个目录不可读而整体失败。
    }
    skills.push({
      name: entry.name,
      declaredName: metadata.name,
      description: metadata.description,
      path: skillPath,
      sizeBytes,
      source:
        catalog[entry.name]?.source == null ? null : redactSource(catalog[entry.name].source),
      sourceType: catalog[entry.name]?.sourceType ?? null,
      installedAt: catalog[entry.name]?.installedAt ?? null,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

async function resolveLinkTarget(entryPath) {
  try {
    return await fsp.realpath(entryPath);
  } catch (realpathError) {
    try {
      const rawTarget = await fsp.readlink(entryPath);
      return path.resolve(path.dirname(entryPath), rawTarget);
    } catch {
      throw realpathError;
    }
  }
}

function managedSkillName(resolvedTarget, warehouse) {
  if (!isPathInside(resolvedTarget, warehouse)) return null;
  const relative = path.relative(warehouse, resolvedTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep).filter(Boolean);
  return parts.length === 1 ? parts[0] : null;
}

async function inspectTargetRoot(targetRoot, warehouse) {
  if (!(await pathExists(targetRoot))) return [];
  const entries = await fsp.readdir(targetRoot, { withFileTypes: true });
  const inspected = [];

  for (const entry of entries) {
    if (entry.name.startsWith(INTERNAL_ENTRY_PREFIX)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = path.join(targetRoot, entry.name);
    const stat = await fsp.lstat(entryPath);
    if (!stat.isSymbolicLink()) {
      inspected.push({
        name: entry.name,
        path: entryPath,
        kind: "directory",
        managed: false,
        target: null,
        skill: null,
      });
      continue;
    }

    let resolvedTarget = null;
    let broken = false;
    try {
      resolvedTarget = await resolveLinkTarget(entryPath);
    } catch {
      broken = true;
    }
    const skill = resolvedTarget ? managedSkillName(resolvedTarget, warehouse) : null;
    inspected.push({
      name: entry.name,
      path: entryPath,
      kind: broken ? "broken-link" : "link",
      managed: Boolean(skill),
      target: resolvedTarget,
      skill,
    });
  }

  return inspected.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

async function mappingRootAvailability(root) {
  try {
    const stat = await fsp.stat(root);
    if (stat.isDirectory()) return { available: true, root };
    return {
      available: false,
      root,
      code: "mapping_root_not_directory",
      message: `映射根路径不是目录：${root}`,
    };
  } catch (error) {
    return {
      available: false,
      root,
      code: "mapping_root_unavailable",
      message: `映射根目录不可访问：${root}`,
      cause: error.code || "error",
    };
  }
}

async function assertMappingRootAvailable(root) {
  const availability = await mappingRootAvailability(root);
  if (!availability.available) {
    throw new ForkliftError(availability.message, availability.code, {
      root,
      cause: availability.cause,
    });
  }
  return root;
}

function projectSkillsRoot(project, contextPath) {
  const projectRoot = resolveConfiguredPath(project.path, contextPath);
  const root = path.resolve(projectRoot, project.skillsDir);
  if (!isPathInside(root, projectRoot) || samePath(root, projectRoot)) {
    throw new ForkliftError(
      `项目 ${project.name} 的 skillsDir 越过项目边界：${project.skillsDir}`,
      "unsafe_project_skills_root",
    );
  }
  return root;
}

async function resolveThroughExistingAncestor(candidate) {
  let current = path.resolve(candidate);
  const suffix = [];
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const resolvedAncestor = await fsp.realpath(current);
  return path.join(resolvedAncestor, ...suffix);
}

async function pathsReferToSameFile(left, right) {
  if (samePath(left, right)) return true;
  try {
    const [leftStat, rightStat] = await Promise.all([fsp.stat(left), fsp.stat(right)]);
    return sameFileIdentity(leftStat, rightStat);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function resolveOperationalContextPath(contextPath) {
  const requested = path.resolve(contextPath);
  let canonical;
  try {
    canonical = await fsp.realpath(requested);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new ForkliftError(
        `context 路径无法安全解析：${requested}`,
        "unsafe_context_link",
        { cause: error.message },
      );
    }
    try {
      return await resolveThroughExistingAncestor(requested);
    } catch (resolveError) {
      throw new ForkliftError(
        `context 路径无法安全解析：${requested}`,
        "unsafe_context_link",
        { cause: resolveError.message },
      );
    }
  }
  const stat = await fsp.stat(canonical);
  if (stat.nlink > 1) {
    throw new ForkliftError(
      `context 存在硬链接别名，无法建立唯一锁：${requested}`,
      "unsafe_context_hardlink",
      { canonical, links: stat.nlink },
    );
  }
  return canonical;
}

async function assertProjectTargetsIsolated(context, contextPath) {
  const roots = [];
  for (const project of context.projects) {
    const configuredRoot = projectSkillsRoot(project, contextPath);
    let canonicalRoot;
    try {
      canonicalRoot = await resolveThroughExistingAncestor(configuredRoot);
    } catch {
      throw new ForkliftError(
        `项目 ${project.name} 的 Skills 目录包含无法解析的链接：${configuredRoot}`,
        "unsafe_project_link_boundary",
      );
    }
    roots.push({ project, configuredRoot, canonicalRoot });
  }

  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const left = roots[leftIndex];
      const right = roots[rightIndex];
      const configuredOverlap =
        isPathInside(left.configuredRoot, right.configuredRoot) ||
        isPathInside(right.configuredRoot, left.configuredRoot);
      const canonicalOverlap = await pathsOverlapByIdentity(
        left.canonicalRoot,
        right.canonicalRoot,
      );
      if (!configuredOverlap && !canonicalOverlap) continue;
      throw new ForkliftError(
        `项目 ${left.project.name} 与 ${right.project.name} 的 Skills 目录互相重叠`,
        "project_skills_roots_overlap",
        {
          projects: [left.project.id, right.project.id],
          configuredRoots: [left.configuredRoot, right.configuredRoot],
          canonicalRoots: [left.canonicalRoot, right.canonicalRoot],
        },
      );
    }
  }
  return roots;
}

async function resolveSafeContextPaths(context, contextPath) {
  const resolved = resolvedContextPaths(context, contextPath);
  const warehouseCanonical = await resolveThroughExistingAncestor(resolved.warehouse);
  const globalTargetCanonical = await resolveThroughExistingAncestor(resolved.globalTarget);
  const codexConfigCanonical = await resolveThroughExistingAncestor(resolved.codexConfig);
  const reportPathCanonical = await resolveThroughExistingAncestor(resolved.reportPath);
  const contextPathCanonical = await resolveThroughExistingAncestor(contextPath);
  const contextLockPathCanonical = await resolveThroughExistingAncestor(contextLockPath(contextPath));
  let homeCanonical;
  try {
    homeCanonical = await fsp.realpath(os.homedir());
  } catch {
    homeCanonical = path.resolve(os.homedir());
  }

  for (const [label, root] of [
    ["warehouse", warehouseCanonical],
    ["globalTarget", globalTargetCanonical],
  ]) {
    if (samePath(root, homeCanonical) || samePath(root, path.parse(root).root)) {
      throw new ForkliftError(
        `${label} 经链接解析后不能指向用户目录或磁盘根目录：${root}`,
        "unsafe_configured_root",
      );
    }
  }
  if (await pathsOverlapByIdentity(resolved.warehouse, resolved.globalTarget)) {
    throw new ForkliftError(
      "warehouse 与 globalTarget 经链接解析后必须是互不嵌套的独立目录",
      "overlapping_configured_roots",
    );
  }
  if (
    (await isPathInsideByIdentity(resolved.reportPath, resolved.warehouse)) ||
    (await isPathInsideByIdentity(resolved.reportPath, resolved.globalTarget)) ||
    (await pathsReferToSameFile(reportPathCanonical, contextPathCanonical)) ||
    (await pathsReferToSameFile(reportPathCanonical, codexConfigCanonical)) ||
    (await pathsReferToSameFile(reportPathCanonical, contextLockPathCanonical))
  ) {
    throw new ForkliftError(
      "reportPath 不能写入受保护目录，也不能覆盖 context 或 Codex 配置",
      "unsafe_report_path",
    );
  }
  if (
    (await isPathInsideByIdentity(contextPath, resolved.warehouse)) ||
    (await isPathInsideByIdentity(contextPath, resolved.globalTarget))
  ) {
    throw new ForkliftError(
      "context 不能位于中央仓库或 Codex 全局 Skills 目录内",
      "unsafe_context_path",
    );
  }
  return {
    ...resolved,
    warehouseCanonical,
    globalTargetCanonical,
    codexConfigCanonical,
    reportPathCanonical,
    contextPathCanonical,
    contextLockPathCanonical,
  };
}

async function assertProjectSkillsBoundary(project, contextPath, protectedRoots = []) {
  const projectRoot = resolveConfiguredPath(project.path, contextPath);
  if (isBroadProjectPath(projectRoot)) {
    throw new ForkliftError(
      `拒绝把用户目录或磁盘根目录作为项目：${projectRoot}`,
      "unsafe_project_root",
    );
  }
  let canonicalProject;
  try {
    canonicalProject = await fsp.realpath(projectRoot);
  } catch {
    throw new ForkliftError(
      `项目目录不存在或不可解析：${projectRoot}`,
      "project_path_not_found",
    );
  }
  let canonicalHome;
  try {
    canonicalHome = await fsp.realpath(os.homedir());
  } catch {
    canonicalHome = path.resolve(os.homedir());
  }
  if (
    samePath(canonicalProject, canonicalHome) ||
    samePath(canonicalProject, path.parse(canonicalProject).root)
  ) {
    throw new ForkliftError(
      `项目路径经链接解析后不能指向用户目录或磁盘根目录：${canonicalProject}`,
      "unsafe_project_root",
    );
  }
  const skillsRoot = projectSkillsRoot(project, contextPath);
  let resolvedSkillsRoot;
  try {
    resolvedSkillsRoot = await resolveThroughExistingAncestor(skillsRoot);
  } catch {
    throw new ForkliftError(
      `项目 ${project.name} 的 Skills 目录包含无法解析的链接：${skillsRoot}`,
      "unsafe_project_link_boundary",
    );
  }
  if (!isPathInside(resolvedSkillsRoot, canonicalProject) || samePath(resolvedSkillsRoot, canonicalProject)) {
    throw new ForkliftError(
      `项目 ${project.name} 的 Skills 目录经链接解析后越过项目边界：${skillsRoot}`,
      "unsafe_project_link_boundary",
      { projectRoot: canonicalProject, resolvedSkillsRoot },
    );
  }
  for (const protectedRoot of protectedRoots) {
    const canonicalProtected = await resolveThroughExistingAncestor(protectedRoot);
    if (await pathsOverlapByIdentity(resolvedSkillsRoot, canonicalProtected)) {
      throw new ForkliftError(
        `项目 ${project.name} 的 Skills 目录与受保护目录重叠：${skillsRoot}`,
        "project_target_overlaps_protected_root",
        { resolvedSkillsRoot, protectedRoot: canonicalProtected },
      );
    }
  }
  return skillsRoot;
}

function resolveProject(context, reference, contextPath) {
  if (!reference) {
    throw new ForkliftError("项目操作需要 --project", "project_required");
  }
  const ref = String(reference);
  const matches = context.projects.filter((project) => {
    const projectPath = resolveConfiguredPath(project.path, contextPath);
    return project.id === ref || project.name === ref || samePath(projectPath, ref);
  });
  if (matches.length === 0) {
    throw new ForkliftError(`context 中找不到项目：${ref}`, "project_not_found");
  }
  if (matches.length > 1) {
    throw new ForkliftError(`项目引用不唯一：${ref}`, "ambiguous_project");
  }
  return matches[0];
}

async function desiredTarget(context, contextPath, scope, projectReference, skillName) {
  const paths = await resolveSafeContextPaths(context, contextPath);
  if (scope === "global") {
    return { root: paths.globalTarget, target: path.join(paths.globalTarget, skillName), project: null };
  }
  if (scope === "project") {
    await assertProjectTargetsIsolated(context, contextPath);
    const project = resolveProject(context, projectReference, contextPath);
    const root = await assertProjectSkillsBoundary(project, contextPath, [
      paths.warehouseCanonical,
      paths.globalTargetCanonical,
    ]);
    return { root, target: path.join(root, skillName), project };
  }
  throw new ForkliftError(`scope 只能是 global 或 project：${scope}`, "invalid_scope");
}

async function inspectMapping(target, warehouse) {
  let stat;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing", target };
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    return { state: "conflict", target, reason: "目标已存在真实目录或文件" };
  }
  let resolvedTarget;
  try {
    resolvedTarget = await resolveLinkTarget(target);
  } catch {
    return { state: "broken", target, reason: "目标是失效链接" };
  }
  const skill = managedSkillName(resolvedTarget, warehouse);
  if (!skill) {
    return {
      state: "external-link",
      target,
      source: resolvedTarget,
      reason: "链接没有指向中央仓库",
    };
  }
  return { state: "managed", target, source: resolvedTarget, skill };
}

async function ensureMapping(source, target, warehouse, { dryRun = false } = {}) {
  let sourceStat;
  try {
    sourceStat = await fsp.lstat(source);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new ForkliftError(`中央仓库中找不到有效 Skill：${source}`, "central_skill_not_found");
  }
  if (sourceStat.isSymbolicLink()) {
    throw new ForkliftError(
      `中央仓库 Skill 是符号链接或 Junction，拒绝映射：${source}`,
      "unsafe_central_link",
    );
  }
  const canonicalWarehouse = await resolveThroughExistingAncestor(warehouse);
  const canonicalSource = await fsp.realpath(source);
  if (!(await isSkillDirectory(canonicalSource)) || !managedSkillName(canonicalSource, canonicalWarehouse)) {
    throw new ForkliftError(`中央仓库中找不到有效实体 Skill：${source}`, "central_skill_not_found");
  }
  const current = await inspectMapping(target, warehouse);
  if (current.state === "managed" && samePath(current.source, canonicalSource)) {
    return { action: "noop", target, source: canonicalSource };
  }
  if (current.state !== "missing") {
    throw new ForkliftError(
      `不能映射 ${path.basename(target)}：${current.reason || current.state}`,
      "mapping_conflict",
      current,
    );
  }
  if (dryRun) return { action: "create", target, source: canonicalSource, dryRun: true };
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.symlink(canonicalSource, target, process.platform === "win32" ? "junction" : "dir");
  const verified = await inspectMapping(target, warehouse);
  if (verified.state !== "managed" || !samePath(verified.source, canonicalSource)) {
    await fsp.rm(target, { force: true }).catch(() => {});
    throw new ForkliftError(`映射创建后校验失败：${target}`, "mapping_verification_failed");
  }
  return { action: "create", target, source: canonicalSource };
}

async function removeManagedMapping(target, warehouse, { dryRun = false } = {}) {
  const current = await inspectMapping(target, warehouse);
  if (current.state === "missing") return { action: "noop", target };
  if (current.state !== "managed") {
    throw new ForkliftError(
      `拒绝移除非中央仓库映射：${target}`,
      "unsafe_unmap",
      current,
    );
  }
  if (dryRun) return { action: "remove", target, source: current.source, dryRun: true };
  await fsp.rm(target, { force: false, recursive: false });
  return { action: "remove", target, source: current.source };
}

async function stageManagedMappingRemoval(
  target,
  warehouse,
  { dryRun = false, requiredRoot = null } = {},
) {
  if (requiredRoot) await assertMappingRootAvailable(requiredRoot);
  const current = await inspectMapping(target, warehouse);
  if (current.state === "missing") return { action: "noop", target };
  if (current.state !== "managed") {
    throw new ForkliftError(
      `拒绝移除非中央仓库映射：${target}`,
      "unsafe_unmap",
      current,
    );
  }
  if (dryRun) return { action: "remove", target, source: current.source, dryRun: true };
  const stagedPath = path.join(
    path.dirname(target),
    `${INTERNAL_ENTRY_PREFIX}remove-${path.basename(target)}-${randomUUID()}`,
  );
  await fsp.rename(target, stagedPath);
  return { action: "remove", target, source: current.source, stagedPath };
}

async function rollbackStagedMappings(actions) {
  const rollbackErrors = [];
  for (const action of [...actions].reverse()) {
    if (action.action !== "remove" || !action.stagedPath) continue;
    try {
      if (await pathExists(action.target)) {
        throw new ForkliftError(`回滚目标已被占用：${action.target}`, "rollback_conflict");
      }
      await fsp.rename(action.stagedPath, action.target);
    } catch (error) {
      rollbackErrors.push(`${action.target}: ${error.message}`);
    }
  }
  return rollbackErrors;
}

async function stageManagedMappings(targets, warehouse) {
  const actions = [];
  try {
    for (const target of targets) {
      actions.push(await stageManagedMappingRemoval(target, warehouse));
    }
    return actions;
  } catch (error) {
    const rollbackErrors = await rollbackStagedMappings(actions);
    if (rollbackErrors.length) {
      throw new ForkliftError(
        `${error.message}；映射回滚未完全成功：${rollbackErrors.join("；")}`,
        "mapping_remove_rollback_failed",
        { originalCode: error.code || "error", rollbackErrors },
      );
    }
    throw error;
  }
}

async function commitStagedMappings(actions) {
  const cleanupPending = [];
  for (const action of actions) {
    if (action.action !== "remove" || !action.stagedPath) continue;
    try {
      await fsp.rm(action.stagedPath, { force: false, recursive: false });
    } catch {
      if (await pathExists(action.stagedPath)) cleanupPending.push(action.stagedPath);
    }
  }
  return cleanupPending;
}

function isBroadProjectPath(projectPath) {
  const resolved = path.resolve(projectPath);
  if (samePath(resolved, os.homedir())) return true;
  return samePath(resolved, path.parse(resolved).root);
}

async function readCodexProjectCandidates(codexConfigPath, { allowMissing = true } = {}) {
  let content;
  try {
    content = await fsp.readFile(codexConfigPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && allowMissing) return [];
    throw new ForkliftError(
      `Codex 配置不可读取：${codexConfigPath}`,
      "codex_config_unavailable",
      { cause: error.message },
    );
  }

  let parsed;
  try {
    parsed = parseToml(content);
  } catch (error) {
    const hasLine = Number.isInteger(error.line);
    const hasColumn = Number.isInteger(error.column);
    const location = hasLine
      ? `（第 ${error.line} 行${hasColumn ? `，第 ${error.column} 列` : ""}）`
      : "";
    throw new ForkliftError(
      `Codex 配置不是合法 TOML${location}`,
      "invalid_codex_config",
      {
        ...(hasLine ? { line: error.line } : {}),
        ...(hasColumn ? { column: error.column } : {}),
      },
    );
  }

  const candidates = [];
  const seen = new Set();
  const projects = parsed?.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return candidates;
  for (const rawPath of Object.keys(projects)) {
    const projectPath = path.resolve(expandPathVariables(rawPath));
    if (isBroadProjectPath(projectPath)) continue;
    const identity = normalizeForCompare(projectPath);
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push(projectPath);
  }
  return candidates.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

async function discoverCodexProjectPaths(codexConfigPath) {
  const candidates = await readCodexProjectCandidates(codexConfigPath);
  const discovered = [];
  const seen = new Set();
  for (const candidate of candidates) {
    let projectPath = candidate;
    try {
      if (!(await fsp.stat(projectPath)).isDirectory()) continue;
      projectPath = await fsp.realpath(projectPath);
    } catch {
      continue;
    }
    if (isBroadProjectPath(projectPath)) continue;
    const identity = normalizeForCompare(projectPath);
    if (seen.has(identity)) continue;
    seen.add(identity);
    discovered.push(projectPath);
  }
  return discovered.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function projectRecordForPath(projectPath, usedIds = new Set()) {
  const name = path.basename(projectPath) || projectPath;
  let id = slugify(name);
  if (usedIds.has(id)) id = `${id}-${shortHash(projectPath)}`;
  usedIds.add(id);
  return {
    id,
    name,
    path: projectPath,
    skillsDir: DEFAULT_PROJECT_SKILLS_DIR,
    skills: [],
  };
}

async function buildInventory(context, contextPath) {
  const paths = await resolveSafeContextPaths(context, contextPath);
  const warehouseSkills = await listWarehouseSkills(paths.warehouse, context.catalog);
  const centralNames = new Set(warehouseSkills.map((skill) => skill.name));
  const globalEntries = await inspectTargetRoot(paths.globalTarget, paths.warehouseCanonical);
  const globalManaged = new Set(
    globalEntries.filter((entry) => entry.managed).map((entry) => entry.skill),
  );
  const globalByName = new Map(globalEntries.map((entry) => [entry.name, entry]));
  const desiredGlobal = new Set(context.globalSkills);

  const projectInventories = [];
  const actualProjectsBySkill = new Map();
  const unmanagedProjectsBySkill = new Map();
  const desiredProjectsBySkill = new Map();

  for (const project of context.projects) {
    let root = projectSkillsRoot(project, contextPath);
    let entries = [];
    let scanError = null;
    try {
      root = await assertProjectSkillsBoundary(project, contextPath, [
        paths.warehouseCanonical,
        paths.globalTargetCanonical,
      ]);
      entries = await inspectTargetRoot(root, paths.warehouseCanonical);
    } catch (error) {
      scanError = { code: error.code || "project_scan_failed", message: error.message };
    }
    const managed = new Set(entries.filter((entry) => entry.managed).map((entry) => entry.skill));
    const unmanaged = entries.filter((entry) => !entry.managed);
    const desired = new Set(project.skills);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const missing = [...desired].filter((skill) => !managed.has(skill));
    const extra = [...managed].filter((skill) => !desired.has(skill));
    const conflicts = missing
      .map((skill) => byName.get(skill))
      .filter(Boolean)
      .filter((entry) => !entry.managed);

    for (const skill of managed) {
      const list = actualProjectsBySkill.get(skill) ?? [];
      list.push(project.id);
      actualProjectsBySkill.set(skill, list);
    }
    for (const entry of unmanaged) {
      const list = unmanagedProjectsBySkill.get(entry.name) ?? [];
      list.push(project.id);
      unmanagedProjectsBySkill.set(entry.name, list);
    }
    for (const skill of desired) {
      const list = desiredProjectsBySkill.get(skill) ?? [];
      list.push(project.id);
      desiredProjectsBySkill.set(skill, list);
    }

    projectInventories.push({
      id: project.id,
      name: project.name,
      path: resolveConfiguredPath(project.path, contextPath),
      skillsRoot: root,
      desiredSkills: [...desired].sort(),
      actualSkills: entries.map((entry) => entry.name).sort(),
      managedSkills: [...managed].sort(),
      missing,
      extra,
      conflicts,
      unmanaged,
      scanError,
      healthy:
        !scanError && missing.length === 0 && conflicts.length === 0 && unmanaged.length === 0,
    });
  }

  const warnings = [];
  for (const skill of desiredGlobal) {
    if (!centralNames.has(skill)) {
      warnings.push({ level: "error", code: "missing_central_skill", message: `全局配置引用了中央仓库中不存在的 ${skill}` });
    } else if (!globalManaged.has(skill)) {
      const conflict = globalByName.get(skill);
      warnings.push({
        level: conflict ? "error" : "warning",
        code: conflict ? "global_conflict" : "global_missing",
        message: conflict
          ? `全局目标 ${skill} 已被非 Forklift 目录或链接占用`
          : `全局 Skill ${skill} 尚未建立映射`,
      });
    }
  }
  for (const skill of globalManaged) {
    if (!desiredGlobal.has(skill)) {
      warnings.push({ level: "info", code: "global_extra", message: `全局存在未写入 context 的中央映射 ${skill}` });
    }
  }
  for (const project of projectInventories) {
    if (project.scanError) {
      warnings.push({
        level: "error",
        code: project.scanError.code,
        message: `${project.name} 无法安全扫描：${project.scanError.message}`,
      });
    }
    for (const skill of project.missing) {
      warnings.push({
        level: project.conflicts.some((entry) => entry.name === skill) ? "error" : "warning",
        code: "project_missing",
        message: `${project.name} 缺少配置中的 ${skill} 映射`,
      });
    }
    for (const skill of project.extra) {
      warnings.push({ level: "info", code: "project_extra", message: `${project.name} 存在未写入 context 的中央映射 ${skill}` });
    }
    if (project.unmanaged.length) {
      warnings.push({
        level: "info",
        code: "project_unmanaged",
        message: `${project.name} 有 ${project.unmanaged.length} 个未纳入中央仓库的项目 Skill`,
      });
    }
  }

  const protectedGlobal = globalEntries.filter((entry) => entry.name === ".system");
  const unmanagedGlobal = globalEntries.filter(
    (entry) => !entry.managed && entry.name !== ".system",
  );
  const unmanagedGlobalNames = new Set(unmanagedGlobal.map((entry) => entry.name));
  for (const entry of unmanagedGlobal) {
    warnings.push({
      level: "info",
      code: "global_unmanaged",
      message: `全局目录中的 ${entry.name} 尚未纳入中央仓库`,
    });
  }

  const desiredNames = new Set([
    ...context.globalSkills,
    ...context.projects.flatMap((project) => project.skills),
  ]);
  const allSkillNames = new Set([
    ...warehouseSkills.map((skill) => skill.name),
    ...unmanagedGlobalNames,
    ...unmanagedProjectsBySkill.keys(),
    ...desiredNames,
  ]);
  const warehouseByName = new Map(warehouseSkills.map((skill) => [skill.name, skill]));
  const skills = [...allSkillNames].map((skillName) => {
    const central = warehouseByName.get(skillName);
    const desiredProjects = desiredProjectsBySkill.get(skillName) ?? [];
    const actualProjects = actualProjectsBySkill.get(skillName) ?? [];
    const unmanagedProjects = unmanagedProjectsBySkill.get(skillName) ?? [];
    const globalDesired = desiredGlobal.has(skillName);
    const globalActual = globalManaged.has(skillName);
    const unmanagedGlobalCopy = unmanagedGlobalNames.has(skillName);
    const missingProjects = desiredProjects.filter((id) => !actualProjects.includes(id));
    return {
      ...(central ?? {
        name: skillName,
        declaredName: skillName,
        description: "尚未纳入中央仓库的实体目录、外部链接或缺失配置项。",
        path: null,
        sizeBytes: 0,
        source: null,
        sourceType: "unmanaged",
        installedAt: null,
      }),
      inWarehouse: Boolean(central),
      globalDesired,
      globalActual,
      unmanagedGlobal: unmanagedGlobalCopy,
      desiredProjects,
      actualProjects,
      unmanagedProjects,
      missingProjects,
      healthy:
        Boolean(central) &&
        (!globalDesired || globalActual) &&
        !unmanagedGlobalCopy &&
        missingProjects.length === 0 &&
        unmanagedProjects.length === 0,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

  return {
    generatedAt: new Date().toISOString(),
    contextPath,
    warehouse: paths.warehouse,
    globalTarget: paths.globalTarget,
    reportPath: paths.reportPath,
    summary: {
      centralSkills: warehouseSkills.length,
      globalDesired: desiredGlobal.size,
      globalActual: globalManaged.size,
      projects: projectInventories.length,
      projectAssignments: projectInventories.reduce(
        (sum, project) => sum + project.desiredSkills.length,
        0,
      ),
      warnings: warnings.length,
      unmanagedGlobal: unmanagedGlobal.length,
      unmanagedProjectSkills: projectInventories.reduce(
        (sum, project) => sum + project.unmanaged.length,
        0,
      ),
      observedSkills: skills.length,
    },
    skills,
    global: {
      desiredSkills: [...desiredGlobal].sort(),
      actualSkills: [...globalManaged].sort(),
      unmanaged: unmanagedGlobal,
      protected: protectedGlobal,
    },
    projects: projectInventories,
    warnings,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderReportHtml(inventory) {
  const data = JSON.stringify(inventory).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Skill 叉车管理报告</title>
  <style>
    :root { color-scheme: light; --ink:#17211b; --muted:#64706a; --line:#dce4df; --paper:#f5f7f5; --card:#ffffff; --green:#14532d; --green2:#1f7a43; --soft:#e8f3ec; --amber:#9a6700; --red:#b42318; --blue:#175cd3; }
    * { box-sizing:border-box; }
    body { margin:0; background:linear-gradient(160deg,#eef5ef 0%,#f8f8f4 45%,#edf2ef 100%); color:var(--ink); font:14px/1.55 Inter,"Segoe UI","Microsoft YaHei",sans-serif; }
    .shell { width:min(1240px,calc(100% - 32px)); margin:32px auto 64px; }
    header { padding:28px; color:white; border-radius:22px; background:radial-gradient(circle at 85% 10%,#3b8f5b 0,transparent 36%),linear-gradient(135deg,#102c1d,#17492d); box-shadow:0 18px 50px rgba(19,64,38,.22); }
    .eyebrow { margin:0 0 8px; color:#bde4c9; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
    h1 { margin:0; font-size:clamp(28px,4vw,48px); line-height:1.08; letter-spacing:-.035em; }
    .lead { max-width:780px; margin:12px 0 0; color:#dceee2; font-size:16px; }
    .pathline { margin-top:20px; display:grid; gap:6px; color:#c8dbce; font-size:12px; word-break:break-all; }
    .toolbar { position:sticky; top:12px; z-index:4; display:flex; gap:10px; align-items:center; margin:18px 0; padding:12px; border:1px solid rgba(220,228,223,.92); border-radius:16px; background:rgba(255,255,255,.88); backdrop-filter:blur(14px); box-shadow:0 10px 30px rgba(23,33,27,.08); }
    input { width:100%; border:1px solid var(--line); border-radius:12px; padding:11px 13px; font:inherit; color:var(--ink); background:white; outline:none; }
    input:focus { border-color:#68a47d; box-shadow:0 0 0 3px rgba(80,145,103,.14); }
    .tabs { display:flex; gap:6px; flex-wrap:wrap; }
    button { border:1px solid var(--line); border-radius:999px; padding:9px 13px; background:white; color:var(--ink); cursor:pointer; white-space:nowrap; }
    button.active { border-color:var(--green); background:var(--green); color:white; }
    .summary { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:12px; margin:18px 0; }
    .metric { min-height:108px; padding:17px; border:1px solid var(--line); border-radius:17px; background:rgba(255,255,255,.9); box-shadow:0 8px 24px rgba(23,33,27,.05); }
    .metric strong { display:block; font-size:30px; line-height:1; margin-bottom:10px; }
    .metric span { color:var(--muted); }
    section { margin-top:26px; }
    .section-head { display:flex; justify-content:space-between; align-items:end; gap:16px; margin-bottom:12px; }
    h2 { margin:0; font-size:23px; letter-spacing:-.02em; }
    .section-note { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
    .card { min-width:0; padding:18px; border:1px solid var(--line); border-radius:18px; background:var(--card); box-shadow:0 8px 26px rgba(23,33,27,.055); }
    .card-top { display:flex; justify-content:space-between; gap:14px; align-items:flex-start; }
    .card h3 { margin:0; font-size:17px; word-break:break-word; }
    .muted { color:var(--muted); }
    .description { min-height:44px; margin:10px 0; color:#435049; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
    .chip { display:inline-flex; align-items:center; gap:5px; max-width:100%; padding:4px 8px; border-radius:999px; background:#f0f3f1; color:#33443a; font-size:12px; }
    .chip.ok { background:var(--soft); color:var(--green); }
    .chip.warn { background:#fff4d6; color:var(--amber); }
    .chip.error { background:#feeceb; color:var(--red); }
    .status { flex:0 0 auto; width:10px; height:10px; margin-top:6px; border-radius:50%; background:#5aa574; box-shadow:0 0 0 4px #e5f3ea; }
    .status.bad { background:#d34a3f; box-shadow:0 0 0 4px #fde9e7; }
    .project-path { margin:8px 0 12px; color:var(--muted); font-size:12px; word-break:break-all; }
    .two-col { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .list { margin:0; padding:0; list-style:none; display:grid; gap:8px; }
    .list li { padding:10px 12px; border:1px solid var(--line); border-radius:12px; background:#fff; }
    .warning.error { border-left:4px solid var(--red); }
    .warning.warning { border-left:4px solid #d39b12; }
    .warning.info { border-left:4px solid var(--blue); }
    .empty { padding:28px; text-align:center; border:1px dashed #cfd8d2; border-radius:16px; color:var(--muted); background:rgba(255,255,255,.55); }
    footer { margin-top:36px; color:var(--muted); font-size:12px; text-align:center; }
    [hidden] { display:none !important; }
    @media (max-width:1000px) { .summary { grid-template-columns:repeat(3,1fr); } .grid { grid-template-columns:repeat(2,1fr); } }
    @media (max-width:680px) { .shell { width:min(100% - 20px,1240px); margin-top:10px; } header { padding:22px; border-radius:18px; } .toolbar { align-items:stretch; flex-direction:column; } .summary { grid-template-columns:repeat(2,1fr); } .grid,.two-col { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <p class="eyebrow">Skill Forklift / 本地只读快照</p>
      <h1>Codex Skill 管理报告</h1>
      <p class="lead">一份文件同时回答两件事：每个 Skill 被分配到了哪里，以及每个项目实际看到了哪些 Skill。</p>
      <div class="pathline">
        <span>中央仓库：${escapeHtml(inventory.warehouse)}</span>
        <span>全局目录：${escapeHtml(inventory.globalTarget)}</span>
        <span>生成时间：${escapeHtml(inventory.generatedAt)}</span>
      </div>
    </header>

    <div class="toolbar">
      <input id="search" type="search" placeholder="搜索 Skill、项目、路径或描述…" aria-label="搜索">
      <div class="tabs" role="tablist">
        <button class="active" data-view="all">全部</button>
        <button data-view="skills">按 Skill</button>
        <button data-view="projects">按项目</button>
        <button data-view="warnings">异常</button>
      </div>
    </div>

    <div id="summary" class="summary"></div>
    <section id="skills-section"><div class="section-head"><div><h2>Skill → 使用范围</h2><div class="section-note">中央 Skill 与未纳管实体 Skill 的全局/项目反向视图</div></div></div><div id="skills" class="grid"></div></section>
    <section id="projects-section"><div class="section-head"><div><h2>项目 → Skills</h2><div class="section-note">context 里的项目与磁盘上的实际映射</div></div></div><div id="projects" class="grid"></div></section>
    <section id="warnings-section"><div class="section-head"><div><h2>漂移与未纳管项</h2><div class="section-note">Forklift 不会自动删除这些真实目录</div></div></div><div class="two-col"><div><h3>配置漂移</h3><ul id="warnings" class="list"></ul></div><div><h3>全局未纳管目录</h3><ul id="unmanaged" class="list"></ul></div></div></section>
    <footer>该页面不依赖网络、字体服务或后端；可直接复制、归档和离线打开。Codex 插件技能与 <code>.system</code> 由各自系统管理，不计入 Forklift 分配。</footer>
  </main>
  <script>
    const DATA = ${data};
    const $ = (selector) => document.querySelector(selector);
    const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const formatBytes = (bytes) => bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes/1024).toFixed(1) + ' KB' : (bytes/1048576).toFixed(1) + ' MB';
    const projectNames = new Map(DATA.projects.map(p => [p.id,p.name]));
    let view = 'all';
    let query = '';

    function renderSummary() {
      const metrics = [
        ['中央 Skills',DATA.summary.centralSkills],['观察到的 Skills',DATA.summary.observedSkills],['全局映射',DATA.summary.globalActual+'/'+DATA.summary.globalDesired],
        ['项目',DATA.summary.projects],['项目未纳管',DATA.summary.unmanagedProjectSkills],['提示',DATA.summary.warnings]
      ];
      $('#summary').replaceChildren(...metrics.map(([label,value]) => { const card=make('div','metric'); card.append(make('strong','',String(value)),make('span','',label)); return card; }));
    }

    function skillSearchText(skill) { return [skill.name,skill.declaredName,skill.description,skill.path,skill.source,...skill.desiredProjects.map(id=>projectNames.get(id)||id),...skill.actualProjects.map(id=>projectNames.get(id)||id),...skill.unmanagedProjects.map(id=>projectNames.get(id)||id)].join(' ').toLowerCase(); }
    function renderSkills() {
      const filtered = DATA.skills.filter(skill => !query || skillSearchText(skill).includes(query));
      const nodes = filtered.map(skill => {
        const card=make('article','card');
        const top=make('div','card-top'); const title=make('h3','',skill.name); const dot=make('span','status'+(skill.healthy?'':' bad')); top.append(title,dot); card.append(top);
        card.append(make('div','description',skill.description||'未提供描述'));
        const metaText=skill.inWarehouse ? formatBytes(skill.sizeBytes)+(skill.source?' · '+skill.source:'') : '未纳入中央仓库';
        const meta=make('div','muted',metaText); card.append(meta);
        const chips=make('div','chips');
        if (!skill.inWarehouse) chips.append(make('span','chip error','未入中央仓库'));
        if (skill.globalDesired || skill.globalActual) chips.append(make('span','chip '+(skill.globalDesired===skill.globalActual?'ok':'warn'),skill.globalActual?'全局已映射':'全局待映射'));
        if (skill.unmanagedGlobal) chips.append(make('span','chip error','全局实体副本'));
        for (const id of skill.actualProjects) chips.append(make('span','chip ok',projectNames.get(id)||id));
        for (const id of skill.unmanagedProjects) chips.append(make('span','chip warn',(projectNames.get(id)||id)+' · 项目实体'));
        for (const id of skill.missingProjects) chips.append(make('span','chip warn',(projectNames.get(id)||id)+' 待映射'));
        if (skill.inWarehouse && !skill.globalDesired && !skill.actualProjects.length && !skill.desiredProjects.length && !skill.unmanagedProjects.length) chips.append(make('span','chip','仅在仓库'));
        card.append(chips); return card;
      });
      $('#skills').replaceChildren(...(nodes.length?nodes:[make('div','empty','没有匹配的 Skill')]));
    }

    function projectSearchText(project) { return [project.name,project.path,project.skillsRoot,project.scanError?.message,...project.desiredSkills,...project.actualSkills].join(' ').toLowerCase(); }
    function renderProjects() {
      const filtered = DATA.projects.filter(project => !query || projectSearchText(project).includes(query));
      const nodes = filtered.map(project => {
        const card=make('article','card'); const top=make('div','card-top'); top.append(make('h3','',project.name),make('span','status'+(project.healthy?'':' bad'))); card.append(top);
        card.append(make('div','project-path',project.path));
        const chips=make('div','chips');
        if (project.scanError) chips.append(make('span','chip error','无法安全扫描'));
        for (const skill of project.managedSkills) chips.append(make('span','chip ok',skill));
        for (const item of project.unmanaged) chips.append(make('span','chip warn',item.name+' · 实体'));
        for (const skill of project.missing) chips.append(make('span','chip warn',skill+' 待映射'));
        if (!project.scanError && !project.desiredSkills.length && !project.actualSkills.length) chips.append(make('span','chip','尚未分配 Skill'));
        card.append(chips);
        if (project.unmanaged.length) card.append(make('div','muted',project.unmanaged.length+' 个未纳管目录/链接'));
        return card;
      });
      $('#projects').replaceChildren(...(nodes.length?nodes:[make('div','empty','没有匹配的项目')]));
    }

    function renderWarnings() {
      const warnings = DATA.warnings.filter(item => !query || item.message.toLowerCase().includes(query));
      $('#warnings').replaceChildren(...(warnings.length?warnings.map(item=>make('li','warning '+item.level,item.message)):[make('li','empty','context 与实际映射一致')]));
      const unmanaged = DATA.global.unmanaged.filter(item => !query || [item.name,item.path,item.target].join(' ').toLowerCase().includes(query));
      $('#unmanaged').replaceChildren(...(unmanaged.length?unmanaged.map(item=>make('li','',item.name+' · '+(item.kind==='directory'?'真实目录':'外部/失效链接'))):[make('li','empty','没有未纳管项')]));
    }

    function applyView() {
      $('#skills-section').hidden = !(view==='all'||view==='skills');
      $('#projects-section').hidden = !(view==='all'||view==='projects');
      $('#warnings-section').hidden = !(view==='all'||view==='warnings');
      document.querySelectorAll('[data-view]').forEach(button=>button.classList.toggle('active',button.dataset.view===view));
    }
    function render() { renderSummary(); renderSkills(); renderProjects(); renderWarnings(); applyView(); }
    $('#search').addEventListener('input',event=>{query=event.target.value.trim().toLowerCase(); renderSkills(); renderProjects(); renderWarnings();});
    document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{view=button.dataset.view;applyView();}));
    render();
  </script>
</body>
</html>`;
}

async function assertCopySourceSafe(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    const stat = await fsp.lstat(fullPath);
    if (stat.isSymbolicLink()) {
      throw new ForkliftError(
        `Skill 源目录包含符号链接，出于边界安全拒绝复制：${fullPath}`,
        "unsafe_source_link",
      );
    }
    if (stat.isDirectory() && !SKIP_COPY_NAMES.has(entry.name)) {
      await assertCopySourceSafe(fullPath);
    }
  }
}

async function findSkillCandidates(root, maxDepth = 5, depth = 0, found = []) {
  if (await isSkillDirectory(root)) {
    found.push(root);
    return found;
  }
  if (depth >= maxDepth) return found;
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_COPY_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
    await findSkillCandidates(path.join(root, entry.name), maxDepth, depth + 1, found);
  }
  return found;
}

function looksLikeGitSource(source) {
  return /^(?:https?:\/\/|ssh:\/\/|git@)/i.test(source) || /\.git(?:#.*)?$/i.test(source);
}

function parseGitSource(rawSource, options = {}) {
  let cloneUrl = rawSource;
  let branch = options.branch ? String(options.branch) : null;
  let subpath = options.subpath ? String(options.subpath) : null;
  const githubTree = rawSource.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/tree\/([^/]+)\/(.+)$/i,
  );
  if (githubTree) {
    cloneUrl = `https://github.com/${githubTree[1]}/${githubTree[2]}.git`;
    branch ||= decodeURIComponent(githubTree[3]);
    subpath ||= decodeURIComponent(githubTree[4]);
  }
  return { cloneUrl, branch, subpath };
}

function redactSource(source) {
  return String(source)
    .replace(/([a-z][a-z0-9+.-]*:[\\/]+)[^@\s]+@/gi, "$1***@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/(^|[\s"'(\\/])([^/\s\\:@]+):([^@\s]+)@/g, "$1$2:***@")
    .replace(/(^|[\s"'(])([^/\s:@]+):([^@\s]+)@([^/\s:]+):/g, "$1$2:***@$4:")
    .replace(/\?[^#\s]*/g, "?***")
    .replace(/#[^\s]*/g, "#***")
    .replace(/(;[^=;\s]+)=[^;\s/?#]+/g, "$1=***")
    .replace(
      /((?:authorization|proxy-authorization|cookie|set-cookie|[a-z0-9_-]*(?:token|secret|password|credential|signature|key))\s*:\s*)[^\r\n]+/gi,
      "$1***",
    )
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, "$1***");
}

async function prepareInstallSource(rawSource, options = {}) {
  const expanded = expandPathVariables(rawSource);
  if (await pathExists(expanded)) {
    const root = path.resolve(expanded);
    const rootStat = await fsp.lstat(root);
    if (rootStat.isSymbolicLink()) {
      throw new ForkliftError(
        `Skill 源目录本身是符号链接或 Junction，拒绝跟随复制：${root}`,
        "unsafe_source_link",
      );
    }
    const requested = options.subpath ? path.resolve(root, String(options.subpath)) : root;
    if (!isPathInside(requested, root)) {
      throw new ForkliftError("--subpath 不能逃逸本地源目录", "unsafe_subpath");
    }
    const candidates = await findSkillCandidates(requested);
    if (candidates.length !== 1) {
      throw new ForkliftError(
        candidates.length === 0
          ? `源目录中没有找到 SKILL.md：${requested}`
          : `源目录中找到多个 Skill，请用 --subpath 指定：${candidates.join(", ")}`,
        "ambiguous_skill_source",
        { candidates },
      );
    }
    return { skillDir: candidates[0], cleanup: async () => {}, sourceType: "local", source: root };
  }

  if (!looksLikeGitSource(rawSource)) {
    throw new ForkliftError(
      `既不是本地路径，也不是 Git URL：${redactSource(rawSource)}`,
      "unsupported_source",
    );
  }
  const parsed = parseGitSource(rawSource, options);
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "skill-forklift-"));
  try {
    const cloneArgs = ["clone", "--depth", "1"];
    if (parsed.branch) cloneArgs.push("--branch", parsed.branch);
    cloneArgs.push(parsed.cloneUrl, temporary);
    const cloned = spawnSync("git", cloneArgs, { encoding: "utf8", windowsHide: true });
    if (cloned.status !== 0) {
      throw new ForkliftError(
        `Git clone 失败：${redactSource(cloned.stderr?.trim() || cloned.stdout?.trim() || "未知错误")}`,
        "git_clone_failed",
        { source: redactSource(rawSource) },
      );
    }
    const requested = parsed.subpath ? path.resolve(temporary, parsed.subpath) : temporary;
    if (!isPathInside(requested, temporary)) {
      throw new ForkliftError("Git --subpath 不能逃逸克隆目录", "unsafe_subpath");
    }
    const candidates = await findSkillCandidates(requested);
    if (candidates.length !== 1) {
      throw new ForkliftError(
        candidates.length === 0
          ? "Git 仓库中没有找到 SKILL.md"
          : `Git 仓库中找到多个 Skill，请用 --subpath 指定：${candidates.map((item) => path.relative(temporary, item)).join(", ")}`,
        "ambiguous_skill_source",
        { candidates: candidates.map((item) => path.relative(temporary, item)) },
      );
    }
    return {
      skillDir: candidates[0],
      cleanup: () => fsp.rm(temporary, { recursive: true, force: true }),
      sourceType: "git",
      source: redactSource(rawSource),
      subpath: path.relative(temporary, candidates[0]).replaceAll(path.sep, "/") || null,
    };
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function copySkillIntoWarehouse(
  sourceDir,
  destination,
  { force = false, dryRun = false, deferCommit = false } = {},
) {
  const warehouse = path.dirname(destination);
  validateSkillName(path.basename(destination));
  if ((await fsp.lstat(sourceDir)).isSymbolicLink()) {
    throw new ForkliftError(
      `Skill 源目录本身是符号链接或 Junction，拒绝跟随复制：${sourceDir}`,
      "unsafe_source_link",
    );
  }
  const canonicalSource = await fsp.realpath(sourceDir);
  const canonicalWarehouse = await resolveThroughExistingAncestor(warehouse);
  const canonicalDestination = await resolveThroughExistingAncestor(destination);
  if (
    !samePath(canonicalSource, canonicalDestination) &&
    (isPathInside(canonicalWarehouse, canonicalSource) ||
      isPathInside(canonicalSource, canonicalDestination))
  ) {
    throw new ForkliftError(
      "Skill 源目录与中央仓库目标经链接解析后互相嵌套，拒绝复制以避免递归或自覆盖",
      "overlapping_source_destination",
      { sourceDir: canonicalSource, destination: canonicalDestination },
    );
  }
  await assertCopySourceSafe(sourceDir);
  if (await pathExists(destination)) {
    const existingStat = await fsp.lstat(destination);
    if (existingStat.isSymbolicLink()) {
      throw new ForkliftError(
        `中央仓库目标是符号链接或 Junction，拒绝替换：${destination}`,
        "unsafe_central_link",
      );
    }
    if (!force) {
      throw new ForkliftError(
        `中央仓库已存在 ${path.basename(destination)}；如需替换请显式传入 --force`,
        "central_skill_exists",
      );
    }
  }
  if (dryRun) {
    return {
      report: {
        action: (await pathExists(destination)) ? "replace" : "install",
        destination,
        dryRun: true,
      },
      transaction: null,
    };
  }

  await fsp.mkdir(warehouse, { recursive: true });
  const staging = path.join(warehouse, `.forklift-staging-${path.basename(destination)}-${randomUUID()}`);
  const backup = path.join(warehouse, `.forklift-backup-${path.basename(destination)}-${randomUUID()}`);
  await fsp.cp(sourceDir, staging, {
    recursive: true,
    errorOnExist: true,
    filter: (source) => !SKIP_COPY_NAMES.has(path.basename(source)),
  });
  if (!(await isSkillDirectory(staging))) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw new ForkliftError("复制后的目录没有有效 SKILL.md", "copy_verification_failed");
  }

  const existed = await pathExists(destination);
  try {
    if (existed) await fsp.rename(destination, backup);
    await fsp.rename(staging, destination);
    if (existed && !deferCommit) await fsp.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    if ((await pathExists(backup)) && !(await pathExists(destination))) {
      await fsp.rename(backup, destination).catch(() => {});
    }
    throw error;
  }
  return {
    report: { action: existed ? "replace" : "install", destination },
    transaction: deferCommit
      ? { destination, backup: existed ? backup : null }
      : null,
  };
}

async function rollbackWarehouseInstall(transaction) {
  if (!transaction) return;
  if (await pathExists(transaction.destination)) {
    const stat = await fsp.lstat(transaction.destination);
    if (stat.isSymbolicLink()) {
      throw new ForkliftError(
        `回滚时发现中央目标已变成链接，拒绝递归处理：${transaction.destination}`,
        "rollback_conflict",
      );
    }
    await fsp.rm(transaction.destination, { recursive: true, force: true });
  }
  if (transaction.backup && (await pathExists(transaction.backup))) {
    await fsp.rename(transaction.backup, transaction.destination);
  }
}

async function commitWarehouseInstall(transaction) {
  if (!transaction?.backup) return null;
  try {
    if (await pathExists(transaction.backup)) {
      await fsp.rm(transaction.backup, { recursive: true, force: true });
    }
    return null;
  } catch {
    return transaction.backup;
  }
}

function updateAssignment(context, scope, projectReference, skillName, add, contextPath) {
  const next = cloneContext(context);
  if (scope === "global") {
    const skills = new Set(next.globalSkills);
    if (add) skills.add(skillName);
    else skills.delete(skillName);
    next.globalSkills = uniqueSorted([...skills]);
    return next;
  }
  const selected = resolveProject(next, projectReference, contextPath);
  const project = next.projects.find((item) => item.id === selected.id);
  const skills = new Set(project.skills);
  if (add) skills.add(skillName);
  else skills.delete(skillName);
  project.skills = uniqueSorted([...skills]);
  return next;
}

async function runInit(options, contextPath) {
  if ((await pathExists(contextPath)) && !options.force) {
    throw new ForkliftError(
      `context 已存在：${contextPath}。如需重建请显式传入 --force。`,
      "context_exists",
    );
  }
  const context = normalizeContext({
    version: CONTEXT_VERSION,
    warehouse: String(options.warehouse || DEFAULT_WAREHOUSE),
    globalTarget: String(options.globalTarget || DEFAULT_GLOBAL_TARGET),
    codexConfig: String(options.codexConfig || DEFAULT_CODEX_CONFIG),
    reportPath: String(options.report || DEFAULT_REPORT),
    globalSkills: [],
    projects: [],
    catalog: {},
  });
  const paths = await resolveSafeContextPaths(context, contextPath);
  await fsp.mkdir(paths.warehouse, { recursive: true });
  const usedIds = new Set();
  const discoveredPaths = await discoverCodexProjectPaths(paths.codexConfig);
  context.projects = discoveredPaths.map((projectPath) => projectRecordForPath(projectPath, usedIds));
  await assertProjectTargetsIsolated(context, contextPath);

  const globalEntries = await inspectTargetRoot(paths.globalTarget, paths.warehouseCanonical);
  context.globalSkills = uniqueSorted(
    globalEntries.filter((entry) => entry.managed).map((entry) => entry.skill),
  );
  for (const project of context.projects) {
    try {
      const safeRoot = await assertProjectSkillsBoundary(project, contextPath, [
        paths.warehouseCanonical,
        paths.globalTargetCanonical,
      ]);
      const entries = await inspectTargetRoot(safeRoot, paths.warehouseCanonical);
      project.skills = uniqueSorted(entries.filter((entry) => entry.managed).map((entry) => entry.skill));
    } catch {
      project.skills = [];
    }
  }
  await writeContextAtomic(contextPath, context);
  return {
    ok: true,
    command: "init",
    contextPath,
    warehouse: paths.warehouse,
    globalSkills: context.globalSkills,
    discoveredProjects: context.projects.length,
  };
}

async function runDiscoverProjects(context, contextPath, options) {
  const paths = await resolveSafeContextPaths(context, contextPath);
  const discovered = await discoverCodexProjectPaths(paths.codexConfig);
  const next = cloneContext(context);
  const identities = new Set(
    next.projects.map((project) => normalizeForCompare(resolveConfiguredPath(project.path, contextPath))),
  );
  const usedIds = new Set(next.projects.map((project) => project.id));
  const added = [];
  for (const projectPath of discovered) {
    if (identities.has(normalizeForCompare(projectPath))) continue;
    const record = projectRecordForPath(projectPath, usedIds);
    next.projects.push(record);
    identities.add(normalizeForCompare(projectPath));
    added.push(record);
  }
  next.projects.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  await assertProjectTargetsIsolated(next, contextPath);
  if (!options.dryRun && added.length) await writeContextAtomic(contextPath, next);
  return { ok: true, command: "discover-projects", dryRun: Boolean(options.dryRun), added };
}

async function runProjectAdd(context, contextPath, options) {
  const rawPath = options.path;
  if (!rawPath) throw new ForkliftError("project-add 需要 --path", "project_path_required");
  let absolutePath = path.resolve(expandPathVariables(String(rawPath)));
  if (isBroadProjectPath(absolutePath)) {
    throw new ForkliftError(
      `拒绝把用户目录或磁盘根目录登记为项目：${absolutePath}`,
      "unsafe_project_root",
    );
  }
  if (!options.allowMissing) {
    try {
      if (!(await fsp.stat(absolutePath)).isDirectory()) throw new Error("not directory");
      absolutePath = await fsp.realpath(absolutePath);
    } catch {
      throw new ForkliftError(`项目目录不存在：${absolutePath}`, "project_path_not_found");
    }
    if (isBroadProjectPath(absolutePath)) {
      throw new ForkliftError(
        `项目路径经链接解析后不能指向用户目录或磁盘根目录：${absolutePath}`,
        "unsafe_project_root",
      );
    }
  }
  const existing = context.projects.find((project) =>
    samePath(resolveConfiguredPath(project.path, contextPath), absolutePath),
  );
  if (existing) return { ok: true, command: "project-add", action: "noop", project: existing };
  const usedIds = new Set(context.projects.map((project) => project.id));
  const record = projectRecordForPath(absolutePath, usedIds);
  if (options.name) record.name = String(options.name);
  if (options.id) {
    const requestedId = slugify(options.id);
    if (usedIds.has(requestedId)) {
      throw new ForkliftError(`项目 id 已存在：${requestedId}`, "project_id_exists");
    }
    record.id = requestedId;
  }
  if (options.skillsDir) {
    record.skillsDir = validateProjectSkillsDir(options.skillsDir, "--skills-dir");
  }
  const next = cloneContext(context);
  next.projects.push(record);
  next.projects.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  await assertProjectTargetsIsolated(next, contextPath);
  if (!options.allowMissing) {
    const paths = await resolveSafeContextPaths(next, contextPath);
    await assertProjectSkillsBoundary(record, contextPath, [
      paths.warehouseCanonical,
      paths.globalTargetCanonical,
    ]);
  }
  if (!options.dryRun) await writeContextAtomic(contextPath, next);
  return { ok: true, command: "project-add", action: "add", dryRun: Boolean(options.dryRun), project: record };
}

async function runProjectRemove(context, contextPath, options) {
  await assertProjectTargetsIsolated(context, contextPath);
  const project = resolveProject(context, options.project, contextPath);
  const paths = await resolveSafeContextPaths(context, contextPath);
  let safeRoot = null;
  let scanIssue = null;
  try {
    safeRoot = await assertProjectSkillsBoundary(project, contextPath, [
      paths.warehouseCanonical,
      paths.globalTargetCanonical,
    ]);
  } catch (error) {
    if (error.code !== "project_path_not_found") throw error;
    scanIssue = { code: error.code, message: error.message };
  }
  if (safeRoot) {
    const availability = await mappingRootAvailability(safeRoot);
    if (!availability.available) {
      scanIssue = availability;
      safeRoot = null;
    }
  }
  if (!safeRoot) {
    const blockedProject = {
      project: project.id,
      name: project.name,
      path: resolveConfiguredPath(project.path, contextPath),
      configuredSkills: project.skills,
      code: scanIssue?.code || "project_scan_failed",
      message: scanIssue?.message || "项目映射根目录不可扫描",
    };
    if (options.dryRun) {
      return {
        ok: true,
        command: "project-remove",
        dryRun: true,
        project,
        actions: [],
        executable: Boolean(options.force && options.allowUnavailable),
        scanComplete: false,
        blockedProject,
      };
    }
    if (!options.force || !options.allowUnavailable) {
      throw new ForkliftError(
        `项目 ${project.name} 当前不可访问，无法扫描 context 外映射；必须先恢复项目，或在预演后显式传入 --force --allow-unavailable`,
        "project_scan_incomplete",
        { blockedProject },
      );
    }
  }
  const managedEntries = safeRoot
    ? (await inspectTargetRoot(safeRoot, paths.warehouseCanonical)).filter((entry) => entry.managed)
    : [];
  if ((project.skills.length || managedEntries.length) && !options.force && !options.dryRun) {
    throw new ForkliftError(
      `项目 ${project.name} 仍有配置或实际中央映射；请先逐个 unassign，或显式传入 --force。`,
      "project_has_assignments",
      { configuredSkills: project.skills, actualSkills: managedEntries.map((entry) => entry.skill) },
    );
  }
  const plannedActions = [];
  if ((options.force || options.dryRun) && safeRoot) {
    for (const entry of managedEntries) {
      plannedActions.push(
        await stageManagedMappingRemoval(entry.path, paths.warehouseCanonical, { dryRun: true }),
      );
    }
  }
  const next = cloneContext(context);
  next.projects = next.projects.filter((item) => item.id !== project.id);
  if (options.dryRun) {
    return {
      ok: true,
      command: "project-remove",
      dryRun: true,
      project,
      actions: plannedActions,
      executable: true,
      scanComplete: true,
      blockedProject: null,
    };
  }

  const actions = await stageManagedMappings(
    plannedActions.map((planned) => planned.target),
    paths.warehouseCanonical,
  );
  try {
    await writeContextAtomic(contextPath, next);
  } catch (error) {
    const rollbackErrors = await rollbackStagedMappings(actions);
    if (rollbackErrors.length) {
      throw new ForkliftError(
        `${error.message}；项目映射回滚未完全成功：${rollbackErrors.join("；")}`,
        "project_remove_rollback_failed",
        { originalCode: error.code || "error", rollbackErrors },
      );
    }
    throw error;
  }
  const cleanupPending = await commitStagedMappings(actions);
  return {
    ok: true,
    command: "project-remove",
    dryRun: false,
    project,
    actions,
    cleanupPending,
  };
}

async function runAssign(context, contextPath, options, positionals) {
  const skillName = validateSkillName(String(options.skill || positionals[0] || ""));
  const scope = String(options.scope || (options.project ? "project" : "global"));
  const paths = await resolveSafeContextPaths(context, contextPath);
  const source = path.join(paths.warehouseCanonical, skillName);
  const targetInfo = await desiredTarget(context, contextPath, scope, options.project, skillName);
  const action = await ensureMapping(source, targetInfo.target, paths.warehouseCanonical, {
    dryRun: Boolean(options.dryRun),
  });
  const next = updateAssignment(context, scope, options.project, skillName, true, contextPath);
  if (!options.dryRun) {
    try {
      await writeContextAtomic(contextPath, next);
    } catch (error) {
      if (action.action === "create") {
        try {
          await removeManagedMapping(targetInfo.target, paths.warehouseCanonical);
        } catch (rollbackError) {
          throw new ForkliftError(
            `${error.message}；新增映射回滚失败：${rollbackError.message}`,
            "assign_rollback_failed",
            { originalCode: error.code || "error" },
          );
        }
      }
      throw error;
    }
  }
  return {
    ok: true,
    command: "assign",
    scope,
    project: targetInfo.project?.id ?? null,
    skill: skillName,
    action,
    dryRun: Boolean(options.dryRun),
  };
}

async function runUnassign(context, contextPath, options, positionals) {
  const skillName = validateSkillName(String(options.skill || positionals[0] || ""));
  const scope = String(options.scope || (options.project ? "project" : "global"));
  const paths = await resolveSafeContextPaths(context, contextPath);
  const targetInfo = await desiredTarget(context, contextPath, scope, options.project, skillName);
  await assertMappingRootAvailable(targetInfo.root);
  const preview = await stageManagedMappingRemoval(targetInfo.target, paths.warehouseCanonical, {
    dryRun: true,
    requiredRoot: targetInfo.root,
  });
  const next = updateAssignment(context, scope, options.project, skillName, false, contextPath);
  if (options.dryRun) {
    return {
      ok: true,
      command: "unassign",
      scope,
      project: targetInfo.project?.id ?? null,
      skill: skillName,
      action: preview,
      dryRun: true,
    };
  }
  const action = await stageManagedMappingRemoval(targetInfo.target, paths.warehouseCanonical, {
    requiredRoot: targetInfo.root,
  });
  try {
    await writeContextAtomic(contextPath, next);
  } catch (error) {
    const rollbackErrors = await rollbackStagedMappings([action]);
    if (rollbackErrors.length) {
      throw new ForkliftError(
        `${error.message}；解除映射回滚未完全成功：${rollbackErrors.join("；")}`,
        "unassign_rollback_failed",
        { originalCode: error.code || "error", rollbackErrors },
      );
    }
    throw error;
  }
  const cleanupPending = await commitStagedMappings([action]);
  return {
    ok: true,
    command: "unassign",
    scope,
    project: targetInfo.project?.id ?? null,
    skill: skillName,
    action,
    cleanupPending,
    dryRun: false,
  };
}

async function runReconcile(context, contextPath, options) {
  const paths = await resolveSafeContextPaths(context, contextPath);
  await assertProjectTargetsIsolated(context, contextPath);
  const actions = [];
  const errors = [];
  const desiredTargets = new Set();

  const desired = [
    ...context.globalSkills.map((skill) => ({ scope: "global", skill, project: null })),
    ...context.projects.flatMap((project) =>
      project.skills.map((skill) => ({ scope: "project", skill, project: project.id })),
    ),
  ];
  for (const item of desired) {
    const source = path.join(paths.warehouseCanonical, item.skill);
    try {
      const info = await desiredTarget(context, contextPath, item.scope, item.project, item.skill);
      desiredTargets.add(normalizeForCompare(info.target));
      actions.push(
        await ensureMapping(source, info.target, paths.warehouseCanonical, {
          dryRun: Boolean(options.dryRun),
        }),
      );
    } catch (error) {
      errors.push({
        scope: item.scope,
        project: item.project,
        skill: item.skill,
        message: error.message,
        code: error.code || "error",
      });
    }
  }

  if (options.prune) {
    const roots = [paths.globalTarget];
    for (const project of context.projects) {
      try {
        roots.push(
          await assertProjectSkillsBoundary(project, contextPath, [
            paths.warehouseCanonical,
            paths.globalTargetCanonical,
          ]),
        );
      } catch (error) {
        errors.push({
          project: project.id,
          message: error.message,
          code: error.code || "error",
        });
      }
    }
    for (const root of roots) {
      const entries = await inspectTargetRoot(root, paths.warehouseCanonical);
      for (const entry of entries.filter((item) => item.managed)) {
        if (!desiredTargets.has(normalizeForCompare(entry.path))) {
          try {
            actions.push(
              await removeManagedMapping(entry.path, paths.warehouseCanonical, {
                dryRun: Boolean(options.dryRun),
              }),
            );
          } catch (error) {
            errors.push({ skill: entry.skill, message: error.message, code: error.code || "error" });
          }
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    command: "reconcile",
    dryRun: Boolean(options.dryRun),
    prune: Boolean(options.prune),
    actions,
    errors,
  };
}

function validateGitSubpath(subpath) {
  if (!subpath) return null;
  const normalized = path.posix.normalize(String(subpath).replaceAll("\\", "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new ForkliftError("Git --subpath 不能逃逸克隆目录", "unsafe_subpath");
  }
  return normalized;
}

async function runGitInstallDryRun(context, contextPath, options, rawSource) {
  if (!options.name) {
    throw new ForkliftError(
      "Git 来源的无网络预演需要显式传入 --name；实际安装时会再校验 SKILL.md",
      "git_dry_run_requires_name",
    );
  }
  const parsed = parseGitSource(rawSource, options);
  validateGitSubpath(parsed.subpath);
  const skillName = validateSkillName(String(options.name));
  const paths = await resolveSafeContextPaths(context, contextPath);
  const destination = path.join(paths.warehouse, skillName);
  const mappingSource = path.join(paths.warehouseCanonical, skillName);
  if (await pathExists(destination)) {
    const existing = await fsp.lstat(destination);
    if (existing.isSymbolicLink()) {
      throw new ForkliftError(
        `中央仓库目标是符号链接或 Junction，拒绝替换：${destination}`,
        "unsafe_central_link",
      );
    }
    if (!options.force) {
      throw new ForkliftError(
        `中央仓库已存在 ${skillName}；如需替换请显式传入 --force`,
        "central_skill_exists",
      );
    }
  }

  const scope = options.scope ? String(options.scope) : options.project ? "project" : null;
  if (options.project && scope !== "project") {
    throw new ForkliftError("--project 只能与 --scope project 一起使用", "invalid_scope_options");
  }
  let mappingAction = null;
  if (scope) {
    const targetInfo = await desiredTarget(context, contextPath, scope, options.project, skillName);
    const current = await inspectMapping(targetInfo.target, paths.warehouseCanonical);
    if (current.state === "missing") {
      mappingAction = {
        action: "create",
        source: mappingSource,
        target: targetInfo.target,
        dryRun: true,
      };
    } else if (current.state === "managed" && samePath(current.source, mappingSource)) {
      mappingAction = {
        action: "noop",
        source: mappingSource,
        target: targetInfo.target,
        dryRun: true,
      };
    } else {
      throw new ForkliftError(
        `不能映射 ${skillName}：${current.reason || current.state}`,
        "mapping_conflict",
        current,
      );
    }
  }

  return {
    ok: true,
    command: "install",
    skill: skillName,
    source: redactSource(rawSource),
    destination,
    installAction: {
      action: (await pathExists(destination)) ? "replace" : "install",
      destination,
      dryRun: true,
    },
    scope,
    mappingAction,
    backupPath: null,
    cleanupPending: null,
    sourceValidation: "deferred-to-install",
    effects: { networkRead: false, temporaryWrite: false, persistentWrite: false },
    dryRun: true,
  };
}

async function runInstall(context, contextPath, options, positionals, adoptMode = false) {
  const rawSource = String(options.source || positionals[0] || "");
  if (!rawSource) {
    throw new ForkliftError(`${adoptMode ? "adopt" : "install"} 需要 --source 或位置参数`, "source_required");
  }
  if (adoptMode && looksLikeGitSource(rawSource)) {
    throw new ForkliftError("adopt 只接受目标位置中的本地实体 Skill；Git 来源请使用 install", "adopt_requires_local_target");
  }
  if (adoptMode && !options.scope && !options.project) {
    throw new ForkliftError("adopt 必须显式指定 --scope global 或项目作用域", "adopt_scope_required");
  }
  if (!adoptMode && options.dryRun && looksLikeGitSource(rawSource)) {
    return runGitInstallDryRun(context, contextPath, options, rawSource);
  }
  const prepared = await prepareInstallSource(rawSource, options);
  let warehouseTransaction = null;
  let mappingAction = null;
  let backupPath = null;
  let sourceAbsolute = null;
  let contextWritten = false;
  let mappingCreated = false;
  let safePaths = null;
  try {
    const metadata = await readSkillMetadata(prepared.skillDir);
    const skillName = validateSkillName(String(options.name || metadata.name || path.basename(prepared.skillDir)));
    const paths = await resolveSafeContextPaths(context, contextPath);
    safePaths = paths;
    const destination = path.join(paths.warehouse, skillName);
    const mappingSource = path.join(paths.warehouseCanonical, skillName);
    const scope = options.scope ? String(options.scope) : options.project ? "project" : null;
    if (options.project && scope !== "project") {
      throw new ForkliftError("--project 只能与 --scope project 一起使用", "invalid_scope_options");
    }
    let targetInfo = null;
    let sourceIsCurrentTarget = false;
    if (scope) {
      targetInfo = await desiredTarget(context, contextPath, scope, options.project, skillName);
      sourceAbsolute = prepared.sourceType === "local" ? await fsp.realpath(prepared.skillDir) : null;
      const canonicalTarget = await resolveThroughExistingAncestor(targetInfo.target);
      sourceIsCurrentTarget = Boolean(sourceAbsolute && samePath(sourceAbsolute, canonicalTarget));
      if (adoptMode && !sourceIsCurrentTarget) {
        throw new ForkliftError(
          `adopt 来源必须就是计算出的目标目录：${targetInfo.target}；其他本地来源请使用 install`,
          "adopt_source_not_target",
          { source: sourceAbsolute, target: canonicalTarget },
        );
      }
      if (!sourceIsCurrentTarget || !adoptMode) {
        const current = await inspectMapping(targetInfo.target, paths.warehouseCanonical);
        if (current.state === "missing") {
          mappingAction = {
            action: "create",
            source: mappingSource,
            target: targetInfo.target,
            dryRun: Boolean(options.dryRun),
          };
        } else if (current.state === "managed" && samePath(current.source, mappingSource)) {
          mappingAction = {
            action: "noop",
            source: mappingSource,
            target: targetInfo.target,
            dryRun: Boolean(options.dryRun),
          };
        } else {
          throw new ForkliftError(
            `不能映射 ${skillName}：${current.reason || current.state}`,
            "mapping_conflict",
            current,
          );
        }
      } else {
        const backupRoot = path.join(
          targetInfo.root,
          "..",
          ".skill-forklift-backups",
          new Date().toISOString().replace(/[:.]/g, "-"),
        );
        backupPath = path.join(backupRoot, skillName);
        mappingAction = {
          action: "adopt-and-link",
          source: sourceAbsolute,
          backupPath,
          target: targetInfo.target,
          dryRun: Boolean(options.dryRun),
        };
      }
    }

    let next = cloneContext(context);
    next.catalog[skillName] = {
      source: prepared.source,
      sourceType: prepared.sourceType,
      subpath: prepared.subpath ?? null,
      installedAt: new Date().toISOString(),
    };
    if (scope) {
      next = updateAssignment(next, scope, options.project, skillName, true, contextPath);
    }

    const copied = await copySkillIntoWarehouse(prepared.skillDir, destination, {
      force: Boolean(options.force),
      dryRun: Boolean(options.dryRun),
      deferCommit: !options.dryRun,
    });
    warehouseTransaction = copied.transaction;

    if (!options.dryRun && scope) {
      if (sourceIsCurrentTarget && adoptMode) {
        await fsp.mkdir(path.dirname(backupPath), { recursive: true });
        await fsp.rename(targetInfo.target, backupPath);
        mappingAction = await ensureMapping(
          mappingSource,
          targetInfo.target,
          paths.warehouseCanonical,
        );
      } else {
        mappingAction = await ensureMapping(
          mappingSource,
          targetInfo.target,
          paths.warehouseCanonical,
        );
      }
      mappingCreated = mappingAction.action === "create";
    }

    if (!options.dryRun) {
      await writeContextAtomic(contextPath, next);
      contextWritten = true;
    }
    const cleanupPending = options.dryRun
      ? null
      : await commitWarehouseInstall(warehouseTransaction);
    return {
      ok: true,
      command: adoptMode ? "adopt" : "install",
      skill: skillName,
      source: prepared.source,
      destination,
      installAction: copied.report,
      scope,
      mappingAction,
      backupPath,
      cleanupPending,
      dryRun: Boolean(options.dryRun),
    };
  } catch (error) {
    if (!options.dryRun && !contextWritten) {
      const rollbackErrors = [];
      if (mappingCreated && safePaths && mappingAction?.target) {
        try {
          await removeManagedMapping(mappingAction.target, safePaths.warehouseCanonical);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError.message);
        }
      }
      if (backupPath && sourceAbsolute && (await pathExists(backupPath))) {
        try {
          if (!(await pathExists(sourceAbsolute))) await fsp.rename(backupPath, sourceAbsolute);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError.message);
        }
      }
      try {
        await rollbackWarehouseInstall(warehouseTransaction);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
      if (rollbackErrors.length) {
        throw new ForkliftError(
          `${error.message}；回滚未完全成功：${rollbackErrors.join("；")}`,
          "install_rollback_failed",
          { originalCode: error.code || "error", rollbackErrors },
        );
      }
    }
    throw error;
  } finally {
    await prepared.cleanup().catch(() => {});
  }
}

async function collectRemovalProjectRoots(context, contextPath, paths, skillName) {
  const roots = [];
  const blockedProjects = [];
  const seenRoots = new Set();
  const seenBlocked = new Set();

  const addProject = async (project, origin) => {
    const blockedKey = `${normalizeForCompare(resolveConfiguredPath(project.path, contextPath))}|${project.skillsDir}`;
    try {
      const root = await assertProjectSkillsBoundary(project, contextPath, [
        paths.warehouseCanonical,
        paths.globalTargetCanonical,
      ]);
      if (origin === "context" && project.skills.includes(skillName)) {
        await assertMappingRootAvailable(root);
      }
      const canonicalRoot = await resolveThroughExistingAncestor(root);
      const identity = normalizeForCompare(canonicalRoot);
      if (seenRoots.has(identity)) return;
      seenRoots.add(identity);
      roots.push({ root, canonicalRoot, project: project.id, name: project.name, origin });
    } catch (error) {
      if (seenBlocked.has(blockedKey)) return;
      seenBlocked.add(blockedKey);
      blockedProjects.push({
        project: project.id,
        name: project.name,
        path: resolveConfiguredPath(project.path, contextPath),
        skillsDir: project.skillsDir,
        origin,
        code: error.code || "project_scan_failed",
        message: error.message,
      });
    }
  };

  for (const project of context.projects) {
    await addProject(project, "context");
    if (project.skillsDir !== DEFAULT_PROJECT_SKILLS_DIR) {
      await addProject(
        { ...project, id: `${project.id}:default`, skillsDir: DEFAULT_PROJECT_SKILLS_DIR },
        "context-default",
      );
    }
  }

  let configuredPaths = [];
  try {
    configuredPaths = await readCodexProjectCandidates(paths.codexConfig, {
      allowMissing: false,
    });
  } catch (error) {
    if (error.code !== "codex_config_unavailable") throw error;
    blockedProjects.push({
      project: null,
      name: "Codex 配置",
      path: paths.codexConfig,
      skillsDir: null,
      origin: "codex-config",
      code: error.code,
      message: error.message,
    });
  }
  const usedIds = new Set(context.projects.map((project) => project.id));
  for (const projectPath of configuredPaths) {
    await addProject(projectRecordForPath(projectPath, usedIds), "codex-config");
  }

  return { roots, blockedProjects };
}

async function runRemove(context, contextPath, options, positionals) {
  const skillName = validateSkillName(String(options.skill || positionals[0] || ""));
  if (!options.dryRun && !options.force) {
    throw new ForkliftError(
      "实际删除中央 Skill 必须显式传入 --force；如需预览请使用 --dry-run",
      "remove_requires_force",
    );
  }
  const paths = await resolveSafeContextPaths(context, contextPath);
  await assertProjectTargetsIsolated(context, contextPath);
  const destination = path.join(paths.warehouse, skillName);
  const canonicalDestination = path.join(paths.warehouseCanonical, skillName);
  if ((await pathExists(destination)) && (await fsp.lstat(destination)).isSymbolicLink()) {
    throw new ForkliftError(
      `中央仓库中的 ${skillName} 是符号链接或 Junction，拒绝递归删除`,
      "unsafe_central_link",
    );
  }
  if (!(await isSkillDirectory(destination))) {
    throw new ForkliftError(`中央仓库中找不到 ${skillName}`, "central_skill_not_found");
  }

  const desiredAssignments = [];
  if (context.globalSkills.includes(skillName)) desiredAssignments.push({ scope: "global" });
  for (const project of context.projects) {
    if (project.skills.includes(skillName)) desiredAssignments.push({ scope: "project", project: project.id });
  }
  const { roots: projectRoots, blockedProjects } = await collectRemovalProjectRoots(
    context,
    contextPath,
    paths,
    skillName,
  );
  if (context.globalSkills.includes(skillName)) {
    const availability = await mappingRootAvailability(paths.globalTarget);
    if (!availability.available) {
      blockedProjects.push({
        project: null,
        name: "全局 Skills",
        path: paths.globalTarget,
        skillsDir: null,
        origin: "global",
        code: availability.code,
        message: availability.message,
      });
    }
  }
  const actualTargets = [];
  const seenTargets = new Set();
  for (const root of [
    { root: paths.globalTarget, canonicalRoot: paths.globalTargetCanonical, origin: "global" },
    ...projectRoots,
  ]) {
    try {
      const entries = await inspectTargetRoot(root.root, paths.warehouseCanonical);
      for (const entry of entries) {
        if (!entry.managed || !entry.target || !samePath(entry.target, canonicalDestination)) continue;
        const identity = normalizeForCompare(entry.path);
        if (seenTargets.has(identity)) continue;
        seenTargets.add(identity);
        actualTargets.push(entry.path);
      }
    } catch (error) {
      blockedProjects.push({
        project: root.project ?? null,
        name: root.name ?? root.origin,
        path: root.root,
        skillsDir: null,
        origin: root.origin,
        code: error.code || "project_scan_failed",
        message: error.message,
      });
    }
  }

  const actions = [];
  if (options.dryRun) {
    for (const target of actualTargets) {
      actions.push(
        await stageManagedMappingRemoval(target, paths.warehouseCanonical, { dryRun: true }),
      );
    }
    const scanComplete = blockedProjects.length === 0;
    if (scanComplete || options.allowUnavailable) {
      actions.push({ action: "remove-central", target: destination, dryRun: true });
    }
    return {
      ok: true,
      command: "remove",
      skill: skillName,
      dryRun: true,
      executable: scanComplete || Boolean(options.allowUnavailable),
      scanComplete,
      desiredAssignments,
      actualTargets,
      blockedProjects,
      actions,
    };
  }
  if (blockedProjects.length && !options.allowUnavailable) {
    throw new ForkliftError(
      "存在无法扫描的已知项目，拒绝删除中央 Skill；恢复项目可访问性，或在预演后显式传入 --allow-unavailable",
      "project_scan_incomplete",
      { blockedProjects },
    );
  }

  const next = cloneContext(context);
  next.globalSkills = next.globalSkills.filter((skill) => skill !== skillName);
  for (const project of next.projects) project.skills = project.skills.filter((skill) => skill !== skillName);
  delete next.catalog[skillName];
  actions.push(...(await stageManagedMappings(actualTargets, paths.warehouseCanonical)));
  const centralStagedPath = path.join(
    paths.warehouse,
    `${INTERNAL_ENTRY_PREFIX}remove-central-${skillName}-${randomUUID()}`,
  );
  let centralStaged = false;
  try {
    await fsp.rename(destination, centralStagedPath);
    centralStaged = true;
    await writeContextAtomic(contextPath, next);
  } catch (error) {
    const rollbackErrors = [];
    let centralRestored = !centralStaged;
    if (centralStaged) {
      try {
        if (await pathExists(destination)) {
          throw new ForkliftError(`中央回滚目标已被占用：${destination}`, "rollback_conflict");
        }
        await fsp.rename(centralStagedPath, destination);
        centralRestored = true;
      } catch (rollbackError) {
        rollbackErrors.push(`中央目录：${rollbackError.message}`);
      }
    }
    if (centralRestored) rollbackErrors.push(...(await rollbackStagedMappings(actions)));
    if (rollbackErrors.length) {
      throw new ForkliftError(
        `${error.message}；删除回滚未完全成功：${rollbackErrors.join("；")}`,
        "remove_rollback_failed",
        { originalCode: error.code || "error", rollbackErrors },
      );
    }
    throw error;
  }

  const cleanupPending = await commitStagedMappings(actions);
  try {
    const stagedStat = await fsp.lstat(centralStagedPath);
    if (stagedStat.isSymbolicLink()) {
      cleanupPending.push(centralStagedPath);
    } else {
      await fsp.rm(centralStagedPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT" && (await pathExists(centralStagedPath))) {
      cleanupPending.push(centralStagedPath);
    }
  }
  actions.push({ action: "remove-central", target: destination });
  return {
    ok: true,
    command: "remove",
    skill: skillName,
    dryRun: false,
    desiredAssignments,
    actualTargets,
    blockedProjects,
    actions,
    cleanupPending,
  };
}

async function runReport(context, contextPath, options) {
  const inventory = await buildInventory(context, contextPath);
  const paths = await resolveSafeContextPaths(context, contextPath);
  const output = options.output
    ? path.resolve(expandPathVariables(String(options.output)))
    : inventory.reportPath;
  const canonicalOutput = await resolveThroughExistingAncestor(output);
  const protectedRoots = [
    paths.warehouse,
    paths.globalTarget,
    ...inventory.projects.map((project) => project.skillsRoot),
  ];
  let outputInsideProtectedRoot = false;
  for (const protectedRoot of protectedRoots) {
    if (await isPathInsideByIdentity(output, protectedRoot)) {
      outputInsideProtectedRoot = true;
      break;
    }
  }
  let outputHasHardlinks = false;
  try {
    const outputStat = await fsp.stat(output);
    outputHasHardlinks = outputStat.isFile() && outputStat.nlink > 1;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    outputInsideProtectedRoot ||
    outputHasHardlinks ||
    (await pathsReferToSameFile(canonicalOutput, paths.contextPathCanonical)) ||
    (await pathsReferToSameFile(canonicalOutput, paths.codexConfigCanonical)) ||
    (await pathsReferToSameFile(canonicalOutput, paths.contextLockPathCanonical))
  ) {
    throw new ForkliftError(
      "报告不能写入受保护目录，也不能覆盖 context、锁文件或 Codex 配置",
      "unsafe_report_path",
    );
  }
  if (!options.dryRun) {
    await writeTextAtomic(output, renderReportHtml(inventory));
  }
  return {
    ok: true,
    command: "report",
    dryRun: Boolean(options.dryRun),
    output,
    summary: inventory.summary,
    warnings: inventory.warnings,
  };
}

function helpText() {
  return `Skill 叉车：用一个 context 管理 Codex 全局与项目 Skill 映射

用法：
  node forklift.mjs init [--context PATH] [--warehouse PATH] [--global-target PATH] [--codex-config PATH] [--report PATH] [--force] [--json]
  node forklift.mjs inventory [--context PATH] [--json]
  node forklift.mjs report [--context PATH] [--output PATH] [--dry-run] [--json]
  node forklift.mjs discover-projects [--context PATH] [--dry-run] [--json]
  node forklift.mjs project-add --path PATH [--id ID] [--name NAME] [--skills-dir PATH] [--allow-missing] [--dry-run] [--context PATH] [--json]
  node forklift.mjs project-remove --project ID [--force] [--allow-unavailable] [--dry-run] [--context PATH] [--json]
  node forklift.mjs install SOURCE [--name NAME] [--branch NAME] [--subpath PATH] [--scope global|project] [--project ID] [--force] [--dry-run] [--context PATH] [--json]
  node forklift.mjs install GIT_URL --name NAME [--branch NAME] [--subpath PATH] --dry-run [--context PATH] [--json]
  node forklift.mjs adopt TARGET --scope global|project [--project ID] [--name NAME] [--branch NAME] [--subpath PATH] [--force] [--dry-run] [--context PATH] [--json]
  node forklift.mjs assign SKILL [--scope global|project] [--project ID] [--dry-run] [--context PATH] [--json]
  node forklift.mjs unassign SKILL [--scope global|project] [--project ID] [--dry-run] [--context PATH] [--json]
  node forklift.mjs reconcile [--prune] [--dry-run] [--context PATH] [--json]
  node forklift.mjs remove SKILL --dry-run [--allow-unavailable] [--context PATH] [--json]
  node forklift.mjs remove SKILL --force [--allow-unavailable] [--context PATH] [--json]

默认 context：./${DEFAULT_CONTEXT_FILE}
也可设置环境变量 SKILL_FORKLIFT_CONTEXT。所有机器解析场景建议加 --json。`;
}

function printHuman(result) {
  if (typeof result === "string") {
    console.log(result);
    return;
  }
  switch (result.command) {
    case "inventory":
      console.log(
        `中央 ${result.summary.centralSkills} 个 Skill；全局 ${result.summary.globalActual}/${result.summary.globalDesired}；项目 ${result.summary.projects} 个；提示 ${result.summary.warnings} 条。`,
      );
      break;
    case "report":
      console.log(`报告已生成：${result.output}`);
      break;
    case "init":
      console.log(`context 已初始化：${result.contextPath}（发现 ${result.discoveredProjects} 个项目）`);
      break;
    default:
      console.log(JSON.stringify(result, null, 2));
  }
}

async function dispatch(command, options, positionals, contextPath) {
  if (command === "help" || command === "--help" || options.help) return helpText();
  contextPath = await resolveOperationalContextPath(contextPath);
  const mutatingCommands = new Set([
    "init",
    "discover-projects",
    "project-add",
    "project-remove",
    "assign",
    "unassign",
    "reconcile",
    "install",
    "adopt",
    "remove",
  ]);
  const releaseLock = mutatingCommands.has(command) && !options.dryRun
    ? await acquireContextLock(contextPath)
    : null;
  try {
    if (command === "init") return await runInit(options, contextPath);

    const context = await loadContext(contextPath);
    switch (command) {
      case "inventory": {
        const inventory = await buildInventory(context, contextPath);
        return { ok: true, command: "inventory", ...inventory };
      }
      case "report":
        return await runReport(context, contextPath, options);
      case "discover-projects":
        return await runDiscoverProjects(context, contextPath, options);
      case "project-add":
        return await runProjectAdd(context, contextPath, options);
      case "project-remove":
        return await runProjectRemove(context, contextPath, options);
      case "assign":
        return await runAssign(context, contextPath, options, positionals);
      case "unassign":
        return await runUnassign(context, contextPath, options, positionals);
      case "reconcile":
        return await runReconcile(context, contextPath, options);
      case "install":
        return await runInstall(context, contextPath, options, positionals, false);
      case "adopt":
        return await runInstall(context, contextPath, options, positionals, true);
      case "remove":
        return await runRemove(context, contextPath, options, positionals);
      default:
        throw new ForkliftError(`未知命令：${command}`, "unknown_command");
    }
  } finally {
    if (releaseLock) await releaseLock().catch(() => {});
  }
}

async function main(argv = process.argv.slice(2)) {
  const { command, options, positionals } = parseArgs(argv);
  try {
    validateCommandLine(command, options, positionals);
    const contextPath = resolveContextPath(options);
    const result = await dispatch(command, options, positionals, contextPath);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (result && typeof result === "object" && result.ok === false) process.exitCode = 2;
    return result;
  } catch (error) {
    const payload = {
      ok: false,
      error: error.message,
      code: error.code || "unexpected_error",
      details: error.details,
    };
    if (options.json) console.error(JSON.stringify(payload, null, 2));
    else console.error(`错误：${error.message}`);
    process.exitCode = 1;
    return payload;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await main();
}

export {
  ForkliftError,
  buildInventory,
  copySkillIntoWarehouse,
  discoverCodexProjectPaths,
  dispatch,
  main,
  normalizeContext,
  parseArgs,
  redactSource,
  renderReportHtml,
  resolveConfiguredPath,
  rollbackWarehouseInstall,
  stageManagedMappings,
};
