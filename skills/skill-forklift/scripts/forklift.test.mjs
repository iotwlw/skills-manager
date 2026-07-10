import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  copySkillIntoWarehouse,
  normalizeContext,
  redactSource,
  rollbackWarehouseInstall,
  stageManagedMappings,
} from "./forklift.mjs";

const CLI = fileURLToPath(new URL("./forklift.mjs", import.meta.url));

function runCli(args, cwd, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--json"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    windowsHide: true,
  });
  const stream = result.status === 0 ? result.stdout : result.stderr;
  let payload;
  try {
    payload = JSON.parse(stream);
  } catch {
    payload = { raw: stream, stdout: result.stdout, stderr: result.stderr };
  }
  return { ...result, payload };
}

function runCliAsync(args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, "--json"], {
      cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const stream = status === 0 ? stdout : stderr;
      let payload;
      try {
        payload = JSON.parse(stream);
      } catch {
        payload = { raw: stream, stdout, stderr };
      }
      resolve({ status, signal, stdout, stderr, payload });
    });
  });
}

async function createSkill(root, name, description = `${name} 测试 Skill`) {
  const skillDir = path.join(root, name);
  await fsp.mkdir(skillDir, { recursive: true });
  await fsp.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
  return skillDir;
}

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "forklift-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const warehouse = path.join(root, "warehouse");
  const globalTarget = path.join(root, "global-skills");
  const project = path.join(root, "project");
  const report = path.join(root, "report.html");
  const contextPath = path.join(root, "context.json");
  const codexConfig = path.join(root, "config.toml");
  await Promise.all([
    fsp.mkdir(warehouse, { recursive: true }),
    fsp.mkdir(globalTarget, { recursive: true }),
    fsp.mkdir(project, { recursive: true }),
    fsp.writeFile(codexConfig, "", "utf8"),
  ]);
  await fsp.writeFile(
    contextPath,
    `${JSON.stringify(
      {
        version: 1,
        warehouse,
        globalTarget,
        codexConfig,
        reportPath: report,
        globalSkills: [],
        projects: [],
        catalog: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { root, warehouse, globalTarget, project, report, contextPath, codexConfig };
}

function localAdminSharePath(localPath) {
  const resolved = path.win32.resolve(localPath);
  const match = resolved.match(/^([a-z]):\\(.*)$/i);
  if (!match) throw new Error(`不是本地盘符路径：${localPath}`);
  return `\\\\localhost\\${match[1].toLowerCase()}$\\${match[2]}`;
}

test("help 完整列出机器输出和 context 参数", async (t) => {
  const env = await fixture(t);
  const result = runCli(["help"], env.root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(typeof result.payload, "string");
  assert.match(
    result.payload,
    /report \[--context PATH\] \[--output PATH\] \[--dry-run\] \[--json\]/,
  );
  assert.match(result.payload, /assign SKILL .*\[--context PATH\] \[--json\]/);
  assert.match(result.payload, /project-add --path PATH \[--id ID\]/);
  assert.match(result.payload, /install SOURCE .*\[--branch NAME\] \[--subpath PATH\]/);
  assert.match(result.payload, /adopt TARGET .*\[--branch NAME\] \[--subpath PATH\]/);
});

test("CLI 通过父级 Junction 调用时仍会执行主入口", async (t) => {
  const env = await fixture(t);
  const skillRoot = fileURLToPath(new URL("../", import.meta.url));
  const aliasRoot = path.join(env.root, "installed-skill-forklift");
  await fsp.symlink(
    skillRoot,
    aliasRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = spawnSync(
    process.execPath,
    [path.join(aliasRoot, "scripts", "forklift.mjs"), "help", "--json"],
    { cwd: env.root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout), /Skill 叉车/);
});

test("安装、全局映射、报告与解除映射形成完整闭环", async (t) => {
  const env = await fixture(t);
  const sourceRoot = path.join(env.root, "sources");
  const source = await createSkill(sourceRoot, "alpha-skill");

  const installPreview = runCli(
    ["install", source, "--context", env.contextPath, "--scope", "global", "--dry-run"],
    env.root,
  );
  assert.equal(installPreview.status, 0, installPreview.stderr);
  assert.equal(installPreview.payload.installAction.dryRun, true);
  assert.equal(installPreview.payload.mappingAction.action, "create");
  await assert.rejects(fsp.lstat(path.join(env.warehouse, "alpha-skill")), { code: "ENOENT" });

  const installed = runCli(
    ["install", source, "--context", env.contextPath, "--scope", "global"],
    env.root,
  );
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.payload.skill, "alpha-skill");
  assert.equal(
    await fsp.realpath(path.join(env.globalTarget, "alpha-skill")),
    await fsp.realpath(path.join(env.warehouse, "alpha-skill")),
  );

  const inventory = runCli(["inventory", "--context", env.contextPath], env.root);
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.equal(inventory.payload.summary.centralSkills, 1);
  assert.equal(inventory.payload.summary.observedSkills, 1);
  assert.deepEqual(inventory.payload.global.desiredSkills, ["alpha-skill"]);
  assert.deepEqual(inventory.payload.global.actualSkills, ["alpha-skill"]);

  const reported = runCli(["report", "--context", env.contextPath], env.root);
  assert.equal(reported.status, 0, reported.stderr);
  const html = await fsp.readFile(env.report, "utf8");
  assert.match(html, /Codex Skill 管理报告/);
  assert.match(html, /alpha-skill/);
  assert.match(html, /不依赖网络/);
  const inlineScript = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Function(inlineScript));

  const removePreview = runCli(
    ["remove", "alpha-skill", "--context", env.contextPath, "--dry-run"],
    env.root,
  );
  assert.equal(removePreview.status, 0, removePreview.stderr);
  assert.deepEqual(removePreview.payload.actions.map((action) => action.action), ["remove", "remove-central"]);
  assert.equal(await fsp.realpath(path.join(env.globalTarget, "alpha-skill")), await fsp.realpath(path.join(env.warehouse, "alpha-skill")));

  const preview = runCli(
    ["unassign", "alpha-skill", "--context", env.contextPath, "--scope", "global", "--dry-run"],
    env.root,
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(await fsp.realpath(path.join(env.globalTarget, "alpha-skill")), await fsp.realpath(path.join(env.warehouse, "alpha-skill")));

  const removed = runCli(
    ["unassign", "alpha-skill", "--context", env.contextPath, "--scope", "global"],
    env.root,
  );
  assert.equal(removed.status, 0, removed.stderr);
  await assert.rejects(fsp.lstat(path.join(env.globalTarget, "alpha-skill")), { code: "ENOENT" });
});

test("项目登记和项目级映射使用 .codex/skills", async (t) => {
  const env = await fixture(t);
  await createSkill(env.warehouse, "project-skill");
  await createSkill(path.join(env.project, ".codex", "skills"), "legacy-project-skill");

  const added = runCli(
    ["project-add", "--context", env.contextPath, "--path", env.project, "--name", "示例项目"],
    env.root,
  );
  assert.equal(added.status, 0, added.stderr);
  const projectId = added.payload.project.id;

  const assigned = runCli(
    ["assign", "project-skill", "--context", env.contextPath, "--scope", "project", "--project", projectId],
    env.root,
  );
  assert.equal(assigned.status, 0, assigned.stderr);
  const projectTarget = path.join(env.project, ".codex", "skills", "project-skill");
  assert.equal(await fsp.realpath(projectTarget), await fsp.realpath(path.join(env.warehouse, "project-skill")));

  const inventory = runCli(["inventory", "--context", env.contextPath], env.root);
  assert.equal(inventory.status, 0, inventory.stderr);
  const projectInventory = inventory.payload.projects.find((project) => project.id === projectId);
  assert.deepEqual(projectInventory.actualSkills, ["legacy-project-skill", "project-skill"]);
  assert.deepEqual(projectInventory.managedSkills, ["project-skill"]);
  assert.deepEqual(projectInventory.unmanaged.map((entry) => entry.name), ["legacy-project-skill"]);

  const reconciled = runCli(["reconcile", "--context", env.contextPath, "--dry-run"], env.root);
  assert.equal(reconciled.status, 0, reconciled.stderr);
  assert.equal(reconciled.payload.errors.length, 0);
  assert.equal(reconciled.payload.actions[0].action, "noop");
});

test("真实目录冲突时拒绝覆盖", async (t) => {
  const env = await fixture(t);
  await createSkill(env.warehouse, "conflict-skill");
  await createSkill(env.globalTarget, "conflict-skill", "用户直接安装的副本");

  const result = runCli(
    ["assign", "conflict-skill", "--context", env.contextPath, "--scope", "global"],
    env.root,
  );
  assert.equal(result.status, 1);
  assert.equal(result.payload.code, "mapping_conflict");
  assert.equal(await fsp.readFile(path.join(env.globalTarget, "conflict-skill", "SKILL.md"), "utf8").then(Boolean), true);
});

test("adopt 会备份直接安装目录，再替换为中央仓库 Junction", async (t) => {
  const env = await fixture(t);
  const direct = await createSkill(env.globalTarget, "legacy-skill");

  const adopted = runCli(
    ["adopt", direct, "--context", env.contextPath, "--scope", "global"],
    env.root,
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.ok(adopted.payload.backupPath);
  assert.equal(await fsp.realpath(direct), await fsp.realpath(path.join(env.warehouse, "legacy-skill")));
  assert.equal(await fsp.readFile(path.join(adopted.payload.backupPath, "SKILL.md"), "utf8").then(Boolean), true);
});

test("context 拒绝越过项目边界的 skillsDir", () => {
  assert.throws(
    () =>
      normalizeContext({
        version: 1,
        warehouse: "C:/warehouse",
        globalTarget: "C:/global-skills",
        codexConfig: "C:/config.toml",
        reportPath: "C:/report.html",
        globalSkills: [],
        projects: [{ id: "unsafe", name: "unsafe", path: "C:/work/project", skillsDir: "../outside", skills: [] }],
        catalog: {},
      }),
    /skillsDir 必须是项目内的相对子目录/,
  );
});

test("context 版本或必填字段异常时拒绝修改且保留原始数据", async (t) => {
  const env = await fixture(t);
  await createSkill(env.warehouse, "context-schema-guard");
  const valid = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  const cases = [
    {
      expectedCode: "unsupported_context_version",
      raw: { ...valid, version: 0, legacyCritical: { keep: true } },
    },
    {
      expectedCode: "invalid_context",
      raw: Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "projects")),
    },
  ];

  for (const item of cases) {
    const before = `${JSON.stringify(item.raw, null, 2)}\n`;
    await fsp.writeFile(env.contextPath, before, "utf8");
    const result = runCli(
      ["assign", "context-schema-guard", "--scope", "global", "--context", env.contextPath],
      env.root,
    );
    assert.equal(result.status, 1);
    assert.equal(result.payload.code, item.expectedCode);
    assert.equal(await fsp.readFile(env.contextPath, "utf8"), before);
    await assert.rejects(
      fsp.lstat(path.join(env.globalTarget, "context-schema-guard")),
      { code: "ENOENT" },
    );
  }
});

test("安装时拒绝跟随作为源根目录的 Junction", async (t) => {
  const env = await fixture(t);
  const realSource = await createSkill(path.join(env.root, "sources"), "linked-source");
  const linkedSource = path.join(env.root, "linked-source");
  await fsp.symlink(realSource, linkedSource, process.platform === "win32" ? "junction" : "dir");

  const result = runCli(["install", linkedSource, "--context", env.contextPath], env.root);
  assert.equal(result.status, 1);
  assert.equal(result.payload.code, "unsafe_source_link");
  await assert.rejects(fsp.lstat(path.join(env.warehouse, "linked-source")), { code: "ENOENT" });
});

test("删除时拒绝把中央仓库中的 Junction 当成实体目录递归处理", async (t) => {
  const env = await fixture(t);
  const realSource = await createSkill(path.join(env.root, "external"), "central-link");
  const centralLink = path.join(env.warehouse, "central-link");
  await fsp.symlink(realSource, centralLink, process.platform === "win32" ? "junction" : "dir");

  const result = runCli(
    ["remove", "central-link", "--context", env.contextPath, "--force"],
    env.root,
  );
  assert.equal(result.status, 1);
  assert.equal(result.payload.code, "unsafe_central_link");
  assert.equal(await fsp.readFile(path.join(realSource, "SKILL.md"), "utf8").then(Boolean), true);
});

test("项目内现有 Junction 指向项目外部时拒绝写入", async (t) => {
  const env = await fixture(t);
  await createSkill(env.warehouse, "boundary-skill");
  const outside = path.join(env.root, "outside-project");
  await fsp.mkdir(outside, { recursive: true });
  await fsp.symlink(outside, path.join(env.project, ".codex"), process.platform === "win32" ? "junction" : "dir");

  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.projects.push({
    id: "boundary-project",
    name: "边界项目",
    path: env.project,
    skillsDir: ".codex/skills",
    skills: [],
  });
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const inventory = runCli(["inventory", "--context", env.contextPath], env.root);
  assert.equal(inventory.status, 0, inventory.stderr);
  const unsafeProject = inventory.payload.projects.find((project) => project.id === "boundary-project");
  assert.equal(unsafeProject.scanError.code, "unsafe_project_link_boundary");
  assert.deepEqual(unsafeProject.actualSkills, []);

  const result = runCli(
    ["assign", "boundary-skill", "--scope", "project", "--project", "boundary-project", "--context", env.contextPath],
    env.root,
  );
  assert.equal(result.status, 1);
  assert.equal(result.payload.code, "unsafe_project_link_boundary");
  await assert.rejects(fsp.lstat(path.join(outside, "skills", "boundary-skill")), { code: "ENOENT" });
});

test("context 拒绝中央仓库与全局目标互相嵌套", async (t) => {
  const env = await fixture(t);
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.globalTarget = path.join(env.warehouse, "global");
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const result = runCli(["inventory", "--context", env.contextPath], env.root);
  assert.equal(result.status, 1);
  assert.equal(result.payload.code, "overlapping_configured_roots");
});

test("安装时拒绝中央仓库位于 Skill 源目录内部", async (t) => {
  const env = await fixture(t);
  const source = await createSkill(path.join(env.root, "source-parent"), "recursive-skill");
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.warehouse = path.join(source, "warehouse");
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const result = runCli(["install", source, "--context", env.contextPath], env.root);
  assert.equal(result.status, 1);
  assert.equal(result.payload.code, "overlapping_source_destination");
});

test("未知参数和 false 布尔值不能绕过删除保护", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "typo-skill");

  const typo = runCli(
    ["remove", "typo-skill", "--context", env.contextPath, "--dry-rnu"],
    env.root,
  );
  assert.equal(typo.status, 1);
  assert.equal(typo.payload.code, "unknown_option");
  assert.equal(await fsp.readFile(path.join(central, "SKILL.md"), "utf8").then(Boolean), true);

  const falseDryRun = runCli(
    ["remove", "typo-skill", "--context", env.contextPath, "--dry-run=false"],
    env.root,
  );
  assert.equal(falseDryRun.status, 1);
  assert.equal(falseDryRun.payload.code, "remove_requires_force");
  assert.equal(await fsp.readFile(path.join(central, "SKILL.md"), "utf8").then(Boolean), true);

  const reconcile = runCli(
    ["reconcile", "--context", env.contextPath, "--dry-run", "--prune=false"],
    env.root,
  );
  assert.equal(reconcile.status, 0, reconcile.stderr);
  assert.equal(reconcile.payload.prune, false);
});

test("安装会在替换中央内容前发现目标映射冲突", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "preflight-skill", "旧中央版本");
  const source = await createSkill(path.join(env.root, "new-source"), "preflight-skill", "新候选版本");
  await createSkill(env.globalTarget, "preflight-skill", "全局实体冲突");

  const result = runCli(
    ["install", source, "--context", env.contextPath, "--force", "--scope", "global"],
    env.root,
  );
  assert.equal(result.status, 1);
  assert.equal(result.payload.code, "mapping_conflict");
  assert.match(await fsp.readFile(path.join(central, "SKILL.md"), "utf8"), /旧中央版本/);
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  assert.equal(context.catalog["preflight-skill"], undefined);
});

test("配置目录通过 Junction 指向同一实体时仍会被识别为重叠", async (t) => {
  const env = await fixture(t);
  const globalAlias = path.join(env.root, "global-alias");
  await fsp.symlink(env.warehouse, globalAlias, process.platform === "win32" ? "junction" : "dir");
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.globalTarget = globalAlias;
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const result = runCli(["inventory", "--context", env.contextPath], env.root);
  assert.equal(result.status, 1);
  assert.equal(result.payload.code, "overlapping_configured_roots");
});

test("项目 Skills 目录不能与全局目标重合", async (t) => {
  const env = await fixture(t);
  await createSkill(env.warehouse, "overlap-skill");
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.projects.push({
    id: "overlap-project",
    name: "重叠项目",
    path: env.root,
    skillsDir: path.basename(env.globalTarget),
    skills: [],
  });
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const result = runCli(
    ["assign", "overlap-skill", "--scope", "project", "--project", "overlap-project", "--context", env.contextPath],
    env.root,
  );
  assert.equal(result.status, 1);
  assert.equal(result.payload.code, "project_target_overlaps_protected_root");
});

test("中央替换事务可以恢复原版本", async (t) => {
  const env = await fixture(t);
  const destination = await createSkill(env.warehouse, "rollback-skill", "原版本");
  const source = await createSkill(path.join(env.root, "replacement"), "rollback-skill", "候选版本");

  const copied = await copySkillIntoWarehouse(source, destination, {
    force: true,
    deferCommit: true,
  });
  assert.match(await fsp.readFile(path.join(destination, "SKILL.md"), "utf8"), /候选版本/);
  await rollbackWarehouseInstall(copied.transaction);
  assert.match(await fsp.readFile(path.join(destination, "SKILL.md"), "utf8"), /原版本/);
});

test(
  "context 写入失败时回滚新安装的中央目录",
  { skip: process.platform !== "win32" },
  async (t) => {
    const env = await fixture(t);
    const source = await createSkill(path.join(env.root, "source"), "context-rollback");
    await fsp.chmod(env.contextPath, 0o444);
    t.after(() => fsp.chmod(env.contextPath, 0o666).catch(() => {}));

    const result = runCli(["install", source, "--context", env.contextPath], env.root);
    assert.equal(result.status, 1);
    await assert.rejects(fsp.lstat(path.join(env.warehouse, "context-rollback")), { code: "ENOENT" });
    const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
    assert.equal(context.catalog["context-rollback"], undefined);
  },
);

test("源目录与中央仓库通过父级 Junction 重叠时仍会被拒绝", async (t) => {
  const env = await fixture(t);
  const source = await createSkill(path.join(env.root, "source"), "alias-overlap");
  const nestedWarehouse = path.join(source, "nested-warehouse");
  await fsp.mkdir(nestedWarehouse, { recursive: true });
  const warehouseAlias = path.join(env.root, "warehouse-alias");
  await fsp.symlink(
    nestedWarehouse,
    warehouseAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.warehouse = warehouseAlias;
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const result = runCli(["install", source, "--context", env.contextPath], env.root);
  assert.equal(result.status, 1);
  assert.equal(result.payload.code, "overlapping_source_destination");
});

test(
  "Windows verbatim 前缀不能绕过配置根目录重叠检查",
  { skip: process.platform !== "win32" },
  async (t) => {
    const env = await fixture(t);
    const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
    context.globalTarget = `\\\\?\\${env.warehouse}`;
    await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

    const result = runCli(["inventory", "--context", env.contextPath], env.root);
    assert.equal(result.status, 1);
    assert.equal(result.payload.code, "overlapping_configured_roots");
  },
);

test("context 中把用户目录登记为项目时只报告错误且拒绝写入", async (t) => {
  const env = await fixture(t);
  await createSkill(env.warehouse, "home-project-skill");
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.projects.push({
    id: "home-project",
    name: "用户目录",
    path: os.homedir(),
    skillsDir: ".codex/skills",
    skills: [],
  });
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const inventory = runCli(["inventory", "--context", env.contextPath], env.root);
  assert.equal(inventory.status, 0, inventory.stderr);
  const project = inventory.payload.projects.find((item) => item.id === "home-project");
  assert.equal(project.scanError.code, "unsafe_project_root");

  const assigned = runCli(
    ["assign", "home-project-skill", "--scope", "project", "--project", "home-project", "--context", env.contextPath],
    env.root,
  );
  assert.equal(assigned.status, 1);
  assert.equal(assigned.payload.code, "unsafe_project_root");
});

test("项目路径通过 Junction 指向用户目录时仍会被拒绝", async (t) => {
  const env = await fixture(t);
  const homeAlias = path.join(env.root, "home-alias");
  await fsp.symlink(os.homedir(), homeAlias, process.platform === "win32" ? "junction" : "dir");
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.projects.push({
    id: "home-alias",
    name: "用户目录别名",
    path: homeAlias,
    skillsDir: ".codex/skills",
    skills: [],
  });
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const inventory = runCli(["inventory", "--context", env.contextPath], env.root);
  assert.equal(inventory.status, 0, inventory.stderr);
  const project = inventory.payload.projects.find((item) => item.id === "home-alias");
  assert.equal(project.scanError.code, "unsafe_project_root");
});

test(
  "context 写入失败时 assign 回滚、unassign 与 remove 保留现状",
  { skip: process.platform !== "win32" },
  async (t) => {
    const env = await fixture(t);
    await createSkill(env.warehouse, "mutation-order");
    const target = path.join(env.globalTarget, "mutation-order");
    t.after(() => fsp.chmod(env.contextPath, 0o666).catch(() => {}));

    await fsp.chmod(env.contextPath, 0o444);
    const assignFailed = runCli(
      ["assign", "mutation-order", "--scope", "global", "--context", env.contextPath],
      env.root,
    );
    assert.equal(assignFailed.status, 1);
    await assert.rejects(fsp.lstat(target), { code: "ENOENT" });

    await fsp.chmod(env.contextPath, 0o666);
    const assigned = runCli(
      ["assign", "mutation-order", "--scope", "global", "--context", env.contextPath],
      env.root,
    );
    assert.equal(assigned.status, 0, assigned.stderr);
    assert.equal(await fsp.realpath(target), await fsp.realpath(path.join(env.warehouse, "mutation-order")));

    await fsp.chmod(env.contextPath, 0o444);
    const unassignFailed = runCli(
      ["unassign", "mutation-order", "--scope", "global", "--context", env.contextPath],
      env.root,
    );
    assert.equal(unassignFailed.status, 1);
    assert.equal(await fsp.realpath(target), await fsp.realpath(path.join(env.warehouse, "mutation-order")));

    const removeFailed = runCli(
      ["remove", "mutation-order", "--force", "--context", env.contextPath],
      env.root,
    );
    assert.equal(removeFailed.status, 1);
    assert.equal(await fsp.realpath(target), await fsp.realpath(path.join(env.warehouse, "mutation-order")));
    assert.equal(await fsp.readFile(path.join(env.warehouse, "mutation-order", "SKILL.md"), "utf8").then(Boolean), true);
  },
);

test(
  "project-remove 写入失败时恢复已移除的项目映射",
  { skip: process.platform !== "win32" },
  async (t) => {
    const env = await fixture(t);
    await createSkill(env.warehouse, "project-rollback");
    const added = runCli(
      ["project-add", "--path", env.project, "--context", env.contextPath],
      env.root,
    );
    assert.equal(added.status, 0, added.stderr);
    const projectId = added.payload.project.id;
    const assigned = runCli(
      ["assign", "project-rollback", "--scope", "project", "--project", projectId, "--context", env.contextPath],
      env.root,
    );
    assert.equal(assigned.status, 0, assigned.stderr);
    const target = path.join(env.project, ".codex", "skills", "project-rollback");

    await fsp.chmod(env.contextPath, 0o444);
    t.after(() => fsp.chmod(env.contextPath, 0o666).catch(() => {}));
    const removed = runCli(
      ["project-remove", "--project", projectId, "--force", "--context", env.contextPath],
      env.root,
    );
    assert.equal(removed.status, 1);
    assert.equal(await fsp.realpath(target), await fsp.realpath(path.join(env.warehouse, "project-rollback")));
    const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
    assert.ok(context.projects.some((project) => project.id === projectId));
  },
);

test("project-remove 会识别并处理 context 外的实际中央映射", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "extra-project-link");
  const added = runCli(
    ["project-add", "--path", env.project, "--context", env.contextPath],
    env.root,
  );
  assert.equal(added.status, 0, added.stderr);
  const projectId = added.payload.project.id;
  const target = path.join(env.project, ".codex", "skills", "extra-project-link");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.symlink(central, target, process.platform === "win32" ? "junction" : "dir");

  const blocked = runCli(
    ["project-remove", "--project", projectId, "--context", env.contextPath],
    env.root,
  );
  assert.equal(blocked.status, 1);
  assert.equal(blocked.payload.code, "project_has_assignments");

  const removed = runCli(
    ["project-remove", "--project", projectId, "--force", "--context", env.contextPath],
    env.root,
  );
  assert.equal(removed.status, 0, removed.stderr);
  await assert.rejects(fsp.lstat(target), { code: "ENOENT" });
});

test("project-remove 在项目离线时不会用空期望列表替代实际扫描", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "offline-project-remove");
  const added = runCli(
    ["project-add", "--path", env.project, "--context", env.contextPath],
    env.root,
  );
  assert.equal(added.status, 0, added.stderr);
  const projectId = added.payload.project.id;
  const target = path.join(env.project, ".codex", "skills", "untracked-name");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.symlink(central, target, process.platform === "win32" ? "junction" : "dir");
  const offlinePath = path.join(env.root, "project-offline");
  await fsp.rename(env.project, offlinePath);
  try {
    const preview = runCli(
      ["project-remove", "--project", projectId, "--dry-run", "--context", env.contextPath],
      env.root,
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.payload.scanComplete, false);
    assert.equal(preview.payload.executable, false);

    const blocked = runCli(
      ["project-remove", "--project", projectId, "--context", env.contextPath],
      env.root,
    );
    assert.equal(blocked.status, 1);
    assert.equal(blocked.payload.code, "project_scan_incomplete");
    const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
    assert.ok(context.projects.some((project) => project.id === projectId));

    const acknowledged = runCli(
      [
        "project-remove",
        "--project",
        projectId,
        "--force",
        "--allow-unavailable",
        "--dry-run",
        "--context",
        env.contextPath,
      ],
      env.root,
    );
    assert.equal(acknowledged.status, 0, acknowledged.stderr);
    assert.equal(acknowledged.payload.executable, true);
  } finally {
    await fsp.rename(offlinePath, env.project);
  }
  assert.equal(await fsp.realpath(target), await fsp.realpath(central));
});

test("unassign 在全局或项目映射根临时缺失时保留期望分配", async (t) => {
  const env = await fixture(t);
  await Promise.all([
    createSkill(env.warehouse, "missing-global-root"),
    createSkill(env.warehouse, "missing-project-root"),
  ]);
  const added = runCli(
    ["project-add", "--path", env.project, "--context", env.contextPath],
    env.root,
  );
  assert.equal(added.status, 0, added.stderr);
  const projectId = added.payload.project.id;
  for (const args of [
    ["assign", "missing-global-root", "--scope", "global", "--context", env.contextPath],
    [
      "assign",
      "missing-project-root",
      "--scope",
      "project",
      "--project",
      projectId,
      "--context",
      env.contextPath,
    ],
  ]) {
    const assigned = runCli(args, env.root);
    assert.equal(assigned.status, 0, assigned.stderr);
  }
  const contextBefore = await fsp.readFile(env.contextPath, "utf8");

  const roots = [
    {
      root: env.globalTarget,
      args: ["unassign", "missing-global-root", "--scope", "global"],
      target: path.join(env.globalTarget, "missing-global-root"),
      central: path.join(env.warehouse, "missing-global-root"),
    },
    {
      root: path.join(env.project, ".codex", "skills"),
      args: [
        "unassign",
        "missing-project-root",
        "--scope",
        "project",
        "--project",
        projectId,
      ],
      target: path.join(env.project, ".codex", "skills", "missing-project-root"),
      central: path.join(env.warehouse, "missing-project-root"),
    },
  ];

  for (const [index, item] of roots.entries()) {
    const offline = `${item.root}-offline-${index}`;
    await fsp.rename(item.root, offline);
    try {
      for (const dryRun of [true, false]) {
        const result = runCli(
          [...item.args, ...(dryRun ? ["--dry-run"] : []), "--context", env.contextPath],
          env.root,
        );
        assert.equal(result.status, 1);
        assert.equal(result.payload.code, "mapping_root_unavailable");
        assert.equal(await fsp.readFile(env.contextPath, "utf8"), contextBefore);
      }
    } finally {
      await fsp.rename(offline, item.root);
    }
    assert.equal(await fsp.realpath(item.target), await fsp.realpath(item.central));
  }
});

test("project-remove 在项目在线但 Skills 根缺失时标记扫描不完整", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "project-root-unavailable");
  const added = runCli(
    ["project-add", "--path", env.project, "--context", env.contextPath],
    env.root,
  );
  const projectId = added.payload.project.id;
  const assigned = runCli(
    [
      "assign",
      "project-root-unavailable",
      "--scope",
      "project",
      "--project",
      projectId,
      "--context",
      env.contextPath,
    ],
    env.root,
  );
  assert.equal(assigned.status, 0, assigned.stderr);
  const skillsRoot = path.join(env.project, ".codex", "skills");
  const offline = `${skillsRoot}-offline`;
  const contextBefore = await fsp.readFile(env.contextPath, "utf8");
  await fsp.rename(skillsRoot, offline);
  try {
    const preview = runCli(
      [
        "project-remove",
        "--project",
        projectId,
        "--force",
        "--dry-run",
        "--context",
        env.contextPath,
      ],
      env.root,
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.payload.scanComplete, false);
    assert.equal(preview.payload.executable, false);
    assert.equal(preview.payload.blockedProject.code, "mapping_root_unavailable");

    const blocked = runCli(
      ["project-remove", "--project", projectId, "--force", "--context", env.contextPath],
      env.root,
    );
    assert.equal(blocked.status, 1);
    assert.equal(blocked.payload.code, "project_scan_incomplete");
    assert.equal(await fsp.readFile(env.contextPath, "utf8"), contextBefore);
  } finally {
    await fsp.rename(offline, skillsRoot);
  }
  assert.equal(
    await fsp.realpath(path.join(skillsRoot, "project-root-unavailable")),
    await fsp.realpath(central),
  );
});

test("报告不能覆盖 context 本体或其硬链接", async (t) => {
  const env = await fixture(t);
  const original = await fsp.readFile(env.contextPath, "utf8");

  const direct = runCli(
    ["report", "--context", env.contextPath, "--output", env.contextPath],
    env.root,
  );
  assert.equal(direct.status, 1);
  assert.equal(direct.payload.code, "unsafe_report_path");
  assert.equal(await fsp.readFile(env.contextPath, "utf8"), original);

  const hardLink = path.join(env.root, "context-hard-link.json");
  await fsp.link(env.contextPath, hardLink);
  const linked = runCli(
    ["report", "--context", env.contextPath, "--output", hardLink],
    env.root,
  );
  assert.equal(linked.status, 1);
  assert.equal(linked.payload.code, "unsafe_context_hardlink");
  assert.equal(await fsp.readFile(env.contextPath, "utf8"), original);
  await fsp.rm(hardLink);

  const lockPath = `${env.contextPath}.forklift.lock`;
  const lockOutput = runCli(
    ["report", "--context", env.contextPath, "--output", lockPath],
    env.root,
  );
  assert.equal(lockOutput.status, 1);
  assert.equal(lockOutput.payload.code, "unsafe_report_path");
  await assert.rejects(fsp.lstat(lockPath), { code: "ENOENT" });

  const protectedSkill = await createSkill(env.warehouse, "report-hardlink-protected");
  const protectedManifest = path.join(protectedSkill, "SKILL.md");
  const manifestBefore = await fsp.readFile(protectedManifest, "utf8");
  const manifestHardLink = path.join(env.root, "report-hardlink.html");
  await fsp.link(protectedManifest, manifestHardLink);
  const protectedOutput = runCli(
    ["report", "--context", env.contextPath, "--output", manifestHardLink],
    env.root,
  );
  assert.equal(protectedOutput.status, 1);
  assert.equal(protectedOutput.payload.code, "unsafe_report_path");
  assert.equal(await fsp.readFile(protectedManifest, "utf8"), manifestBefore);
});

test(
  "报告通过本机 UNC 别名时仍不能写入中央、全局或项目 Skills 根",
  { skip: process.platform !== "win32" },
  async (t) => {
    const env = await fixture(t);
    try {
      await fsp.stat(localAdminSharePath(env.root));
    } catch {
      t.skip("当前环境不可访问本机管理共享");
      return;
    }

    const protectedSkill = await createSkill(env.warehouse, "report-unc-protected");
    const protectedManifest = path.join(protectedSkill, "SKILL.md");
    const manifestBefore = await fsp.readFile(protectedManifest, "utf8");
    const added = runCli(
      ["project-add", "--path", env.project, "--context", env.contextPath],
      env.root,
    );
    assert.equal(added.status, 0, added.stderr);
    const projectSkillsRoot = path.join(env.project, ".codex", "skills");
    await fsp.mkdir(projectSkillsRoot, { recursive: true });

    const outputs = [
      localAdminSharePath(protectedManifest),
      localAdminSharePath(path.join(env.globalTarget, "report.html")),
      localAdminSharePath(path.join(projectSkillsRoot, "report.html")),
    ];
    for (const output of outputs) {
      const result = runCli(
        ["report", "--context", env.contextPath, "--output", output],
        env.root,
      );
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.payload.code, "unsafe_report_path");
    }
    assert.equal(await fsp.readFile(protectedManifest, "utf8"), manifestBefore);
    await assert.rejects(fsp.lstat(path.join(env.globalTarget, "report.html")), {
      code: "ENOENT",
    });
    await assert.rejects(fsp.lstat(path.join(projectSkillsRoot, "report.html")), {
      code: "ENOENT",
    });
  },
);

test("context 经父级 Junction 访问时统一锁定物理路径，硬链接别名则拒绝", async (t) => {
  const env = await fixture(t);
  await Promise.all([
    createSkill(env.warehouse, "context-alias-ok"),
    createSkill(env.warehouse, "context-hardlink-blocked"),
  ]);
  const realConfigDir = path.join(env.root, "real-config");
  const aliasConfigDir = path.join(env.root, "alias-config");
  await fsp.mkdir(realConfigDir, { recursive: true });
  const realContext = path.join(realConfigDir, "context.json");
  await fsp.rename(env.contextPath, realContext);
  await fsp.symlink(
    realConfigDir,
    aliasConfigDir,
    process.platform === "win32" ? "junction" : "dir",
  );
  const aliasContext = path.join(aliasConfigDir, "context.json");

  const assigned = runCli(
    ["assign", "context-alias-ok", "--scope", "global", "--context", aliasContext],
    env.root,
  );
  assert.equal(assigned.status, 0, assigned.stderr);
  const updated = JSON.parse(await fsp.readFile(realContext, "utf8"));
  assert.deepEqual(updated.globalSkills, ["context-alias-ok"]);
  assert.equal(await fsp.realpath(aliasContext), await fsp.realpath(realContext));
  await assert.rejects(fsp.lstat(`${aliasContext}.forklift.lock`), { code: "ENOENT" });
  await assert.rejects(fsp.lstat(`${realContext}.forklift.lock`), { code: "ENOENT" });

  const hardLink = path.join(env.root, "context-hardlink.json");
  await fsp.link(realContext, hardLink);
  const before = await fsp.readFile(realContext, "utf8");
  const blocked = runCli(
    ["assign", "context-hardlink-blocked", "--scope", "global", "--context", hardLink],
    env.root,
  );
  assert.equal(blocked.status, 1);
  assert.equal(blocked.payload.code, "unsafe_context_hardlink");
  assert.equal(await fsp.readFile(realContext, "utf8"), before);
  assert.equal(await fsp.readFile(hardLink, "utf8"), before);
  await assert.rejects(
    fsp.lstat(path.join(env.globalTarget, "context-hardlink-blocked")),
    { code: "ENOENT" },
  );
});

test("project-add 在写入前拒绝非法 skillsDir", async (t) => {
  const env = await fixture(t);
  const original = await fsp.readFile(env.contextPath, "utf8");
  for (const skillsDir of ["../outside", "..\\outside", "C:\\outside", "~/outside"]) {
    const result = runCli(
      [
        "project-add",
        "--path",
        env.project,
        "--skills-dir",
        skillsDir,
        "--context",
        env.contextPath,
      ],
      env.root,
    );
    assert.equal(result.status, 1);
    assert.equal(result.payload.code, "invalid_project_skills_dir");
    assert.equal(await fsp.readFile(env.contextPath, "utf8"), original);
  }
});

test("项目 Skills 根重叠时在任何项目写入前停止", async (t) => {
  const env = await fixture(t);
  await createSkill(env.warehouse, "overlap-project-skill");
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.projects = [
    {
      id: "outer",
      name: "外层项目",
      path: env.root,
      skillsDir: "project/.codex/skills",
      skills: [],
    },
    {
      id: "inner",
      name: "内层项目",
      path: env.project,
      skillsDir: ".codex/skills",
      skills: [],
    },
  ];
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const assigned = runCli(
    [
      "assign",
      "overlap-project-skill",
      "--scope",
      "project",
      "--project",
      "outer",
      "--context",
      env.contextPath,
    ],
    env.root,
  );
  assert.equal(assigned.status, 1);
  assert.equal(assigned.payload.code, "project_skills_roots_overlap");
  await assert.rejects(
    fsp.lstat(path.join(env.project, ".codex", "skills", "overlap-project-skill")),
    { code: "ENOENT" },
  );
});

test("warehouse 根为 Junction 时仍能识别完整映射闭环", async (t) => {
  const env = await fixture(t);
  const alias = path.join(env.root, "warehouse-alias");
  await fsp.symlink(env.warehouse, alias, process.platform === "win32" ? "junction" : "dir");
  await createSkill(env.warehouse, "warehouse-alias-skill");
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.warehouse = alias;
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const assigned = runCli(
    ["assign", "warehouse-alias-skill", "--scope", "global", "--context", env.contextPath],
    env.root,
  );
  assert.equal(assigned.status, 0, assigned.stderr);
  const inventory = runCli(["inventory", "--context", env.contextPath], env.root);
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.deepEqual(inventory.payload.global.actualSkills, ["warehouse-alias-skill"]);

  const unassigned = runCli(
    ["unassign", "warehouse-alias-skill", "--scope", "global", "--context", env.contextPath],
    env.root,
  );
  assert.equal(unassigned.status, 0, unassigned.stderr);
});

test("中央仓库直接子 Junction 不会被盘点或映射", async (t) => {
  const env = await fixture(t);
  const external = await createSkill(path.join(env.root, "external"), "external-central", "外部秘密内容");
  const centralLink = path.join(env.warehouse, "external-central");
  await fsp.symlink(external, centralLink, process.platform === "win32" ? "junction" : "dir");

  const inventory = runCli(["inventory", "--context", env.contextPath], env.root);
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.equal(inventory.payload.summary.centralSkills, 0);
  assert.doesNotMatch(JSON.stringify(inventory.payload), /外部秘密内容/);

  const assigned = runCli(
    ["assign", "external-central", "--scope", "global", "--context", env.contextPath],
    env.root,
  );
  assert.equal(assigned.status, 1);
  assert.equal(assigned.payload.code, "unsafe_central_link");
  assert.match(await fsp.readFile(path.join(external, "SKILL.md"), "utf8"), /外部秘密内容/);
});

test("Git 来源凭据会全面脱敏，旧 catalog 也不会泄漏", async (t) => {
  const samples = [
    "https://user:secret@example.com/repo.git",
    "ssh://user:secret@example.com/repo.git",
    "user:secret@example.com:repo.git",
    "https://example.com/repo.git?private_token=SECRET&password=PASS&oauth_token=OAUTH&api_key=KEY",
    "https://example.com/repo.git?X-Amz-Signature=TOPSECRET&X-Amz-Credential=CRED",
    "https://example.com/repo.git?session_token=TOPSECRET&authToken=AUTHSECRET",
    "https://example.com/repo.git#access_token=FRAGMENT_SECRET",
    "Authorization: Bearer TOPSECRET",
    "https:\\user:BACKSLASH_SECRET@example.invalid\\repo.git",
    "https:user:SCHEMELESS_SECRET@example.invalid/repo.git",
    "user:SIMPLE_SECRET@example.invalid/repo.git",
  ];
  for (const sample of samples) {
    const redacted = redactSource(sample);
    assert.doesNotMatch(
      redacted,
      /secret|SECRET|PASS|OAUTH|KEY|TOPSECRET|CRED|AUTHSECRET|FRAGMENT_SECRET/,
    );
    assert.match(redacted, /\*\*\*/);
  }
  assert.equal(redactSource("Authorization: token ghp_SUPERSECRET"), "Authorization: ***");
  assert.equal(redactSource("PRIVATE-TOKEN: GITLAB_SECRET"), "PRIVATE-TOKEN: ***");
  assert.equal(redactSource("X-API-KEY: API_SECRET"), "X-API-KEY: ***");

  const env = await fixture(t);
  await createSkill(env.warehouse, "catalog-secret");
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.catalog["catalog-secret"] = {
    source:
      "https://example.com/repo.git?X-Amz-Signature=CATALOG_SECRET\nPRIVATE-TOKEN: CATALOG_HEADER_SECRET",
    sourceType: "git",
  };
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  const inventory = runCli(["inventory", "--context", env.contextPath], env.root);
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.doesNotMatch(JSON.stringify(inventory.payload), /CATALOG_SECRET|CATALOG_HEADER_SECRET/);
  const report = runCli(["report", "--context", env.contextPath], env.root);
  assert.equal(report.status, 0, report.stderr);
  assert.doesNotMatch(
    await fsp.readFile(env.report, "utf8"),
    /CATALOG_SECRET|CATALOG_HEADER_SECRET/,
  );

  const failed = runCli(
    [
      "install",
      "https://127.0.0.1:1/repo.git?private_token=CLONE_SECRET&password=CLONE_PASS",
      "--context",
      env.contextPath,
    ],
    env.root,
  );
  assert.equal(failed.status, 1);
  assert.doesNotMatch(`${failed.stdout}\n${failed.stderr}`, /CLONE_SECRET|CLONE_PASS/);

  const backslashFailed = runCli(
    [
      "install",
      "https:\\user:BACKSLASH_SECRET@example.invalid\\repo.git",
      "--context",
      env.contextPath,
    ],
    env.root,
  );
  assert.equal(backslashFailed.status, 1);
  assert.doesNotMatch(
    `${backslashFailed.stdout}\n${backslashFailed.stderr}\n${JSON.stringify(backslashFailed.payload)}`,
    /BACKSLASH_SECRET/,
  );

  for (const source of [
    "https:user:SCHEMELESS_SECRET@example.invalid/repo.git",
    "user:SIMPLE_SECRET@example.invalid/repo.git",
  ]) {
    const malformedFailed = runCli(["install", source, "--context", env.contextPath], env.root);
    assert.equal(malformedFailed.status, 1);
    assert.doesNotMatch(
      `${malformedFailed.stdout}\n${malformedFailed.stderr}\n${JSON.stringify(malformedFailed.payload)}`,
      /SCHEMELESS_SECRET|SIMPLE_SECRET/,
    );
  }
});

test("Git dry-run 不联网、不创建临时克隆，并明确延后来源校验", async (t) => {
  const env = await fixture(t);
  const tempRoot = path.join(env.root, "isolated-temp");
  await fsp.mkdir(tempRoot, { recursive: true });
  const preview = runCli(
    [
      "install",
      "https://127.0.0.1:1/never-contact.git?private_token=DRY_SECRET",
      "--name",
      "git-preview",
      "--dry-run",
      "--context",
      env.contextPath,
    ],
    env.root,
    { env: { TEMP: tempRoot, TMP: tempRoot, TMPDIR: tempRoot } },
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.payload.sourceValidation, "deferred-to-install");
  assert.deepEqual(preview.payload.effects, {
    networkRead: false,
    temporaryWrite: false,
    persistentWrite: false,
  });
  assert.deepEqual(await fsp.readdir(tempRoot), []);
  assert.doesNotMatch(JSON.stringify(preview.payload), /DRY_SECRET/);

  const missingName = runCli(
    ["install", "https://example.invalid/repo.git", "--dry-run", "--context", env.contextPath],
    env.root,
  );
  assert.equal(missingName.status, 1);
  assert.equal(missingName.payload.code, "git_dry_run_requires_name");
});

test("adopt 不会静默退化为普通 install", async (t) => {
  const env = await fixture(t);
  const outside = await createSkill(path.join(env.root, "outside"), "outside-adopt");

  const noScope = runCli(["adopt", outside, "--context", env.contextPath], env.root);
  assert.equal(noScope.status, 1);
  assert.equal(noScope.payload.code, "adopt_scope_required");

  const wrongTarget = runCli(
    ["adopt", outside, "--scope", "global", "--context", env.contextPath],
    env.root,
  );
  assert.equal(wrongTarget.status, 1);
  assert.equal(wrongTarget.payload.code, "adopt_source_not_target");
  await assert.rejects(fsp.lstat(path.join(env.warehouse, "outside-adopt")), { code: "ENOENT" });
  assert.equal(await fsp.readFile(path.join(outside, "SKILL.md"), "utf8").then(Boolean), true);

  const gitSource = runCli(
    ["adopt", "https://example.invalid/repo.git", "--scope", "global", "--context", env.contextPath],
    env.root,
  );
  assert.equal(gitSource.status, 1);
  assert.equal(gitSource.payload.code, "adopt_requires_local_target");
});

test("Codex 项目解析支持 quoted key、inline table 与 dotted key", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "toml-project-forms");
  const forms = [
    (key) => `["projects".${key}]\ntrust_level = "trusted"\n`,
    (key) => `projects = { ${key} = { trust_level = "trusted" } }\n`,
    (key) => `projects.${key}.trust_level = "trusted"\n`,
  ];

  for (const [index, render] of forms.entries()) {
    const projectRoot = path.join(env.root, `toml-form-${index + 1}`);
    const target = path.join(projectRoot, ".codex", "skills", `renamed-${index + 1}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.symlink(central, target, process.platform === "win32" ? "junction" : "dir");
    await fsp.writeFile(env.codexConfig, render(JSON.stringify(projectRoot)), "utf8");

    const preview = runCli(
      ["remove", "toml-project-forms", "--dry-run", "--context", env.contextPath],
      env.root,
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.payload.scanComplete, true);
    assert.ok(preview.payload.actualTargets.includes(target));
  }
});

test("remove 会发现 Codex 配置中未登记项目的换名 Junction", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "unregistered-remove");
  const unregistered = path.join(env.root, "unregistered-project-A");
  const target = path.join(unregistered, ".codex", "skills", "renamed-entry");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.symlink(central, target, process.platform === "win32" ? "junction" : "dir");
  const codexConfig = path.join(env.root, "config.toml");
  const encodedProjectPath = unregistered
    .replaceAll("\\", "\\\\")
    .replace(/A$/, "\\U00000041");
  await fsp.writeFile(
    codexConfig,
    `[ "projects" . "${encodedProjectPath}" ] # 合法的 TOML Unicode、空白与行尾注释\ntrust_level = "trusted"\n`,
    "utf8",
  );
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.codexConfig = codexConfig;
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const preview = runCli(
    ["remove", "unregistered-remove", "--dry-run", "--context", env.contextPath],
    env.root,
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.payload.scanComplete, true);
  assert.ok(preview.payload.actualTargets.includes(target));

  const removed = runCli(
    ["remove", "unregistered-remove", "--force", "--context", env.contextPath],
    env.root,
  );
  assert.equal(removed.status, 0, removed.stderr);
  await assert.rejects(fsp.lstat(target), { code: "ENOENT" });
  await assert.rejects(fsp.lstat(central), { code: "ENOENT" });
});

test("Codex 配置任意位置出现非法 TOML 时阻止中央删除且不泄露原文", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "invalid-toml-remove");
  const codexConfig = path.join(env.root, "invalid-config.toml");
  const projectRoot = path.join(env.root, "invalid-toml-project");
  const target = path.join(projectRoot, ".codex", "skills", "invalid-toml-link");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.symlink(central, target, process.platform === "win32" ? "junction" : "dir");
  await fsp.writeFile(
    codexConfig,
    `["projects".${JSON.stringify(projectRoot)}]\napi_key = "TOML_SECRET_SENTINEL"\nbroken = [\n`,
    "utf8",
  );
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.codexConfig = codexConfig;
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const blocked = runCli(
    ["remove", "invalid-toml-remove", "--force", "--context", env.contextPath],
    env.root,
  );
  assert.equal(blocked.status, 1);
  assert.equal(blocked.payload.code, "invalid_codex_config");
  assert.doesNotMatch(`${blocked.stdout}\n${blocked.stderr}`, /TOML_SECRET_SENTINEL/);
  assert.equal(await fsp.readFile(path.join(central, "SKILL.md"), "utf8").then(Boolean), true);
  assert.equal(await fsp.realpath(target), await fsp.realpath(central));
});

test("remove 在已知项目离线时默认拒绝中央删除", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "offline-remove");
  const missingProject = path.join(env.root, "offline-project");
  const codexConfig = path.join(env.root, "config.toml");
  await fsp.writeFile(codexConfig, `[projects.'${missingProject}']\ntrust_level = "trusted"\n`, "utf8");
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  context.codexConfig = codexConfig;
  await fsp.writeFile(env.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const preview = runCli(
    ["remove", "offline-remove", "--dry-run", "--context", env.contextPath],
    env.root,
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.payload.executable, false);
  assert.equal(preview.payload.scanComplete, false);
  assert.ok(preview.payload.blockedProjects.length > 0);
  assert.equal(preview.payload.actions.some((action) => action.action === "remove-central"), false);

  const blocked = runCli(
    ["remove", "offline-remove", "--force", "--context", env.contextPath],
    env.root,
  );
  assert.equal(blocked.status, 1);
  assert.equal(blocked.payload.code, "project_scan_incomplete");
  assert.equal(await fsp.readFile(path.join(central, "SKILL.md"), "utf8").then(Boolean), true);

  const acknowledged = runCli(
    [
      "remove",
      "offline-remove",
      "--dry-run",
      "--allow-unavailable",
      "--context",
      env.contextPath,
    ],
    env.root,
  );
  assert.equal(acknowledged.status, 0, acknowledged.stderr);
  assert.equal(acknowledged.payload.executable, true);
});

test("remove 在 Codex 配置临时不可用时默认拒绝中央删除", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "config-unavailable-remove");
  const projectRoot = path.join(env.root, "config-only-project");
  const target = path.join(projectRoot, ".codex", "skills", "config-only-link");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.symlink(central, target, process.platform === "win32" ? "junction" : "dir");
  await fsp.writeFile(
    env.codexConfig,
    `[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "trusted"\n`,
    "utf8",
  );
  const offlineConfig = `${env.codexConfig}.offline`;
  await fsp.rename(env.codexConfig, offlineConfig);
  try {
    const preview = runCli(
      ["remove", "config-unavailable-remove", "--dry-run", "--context", env.contextPath],
      env.root,
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.payload.scanComplete, false);
    assert.equal(preview.payload.executable, false);
    assert.ok(
      preview.payload.blockedProjects.some(
        (project) => project.code === "codex_config_unavailable",
      ),
    );
    assert.equal(
      preview.payload.actions.some((action) => action.action === "remove-central"),
      false,
    );

    const blocked = runCli(
      ["remove", "config-unavailable-remove", "--force", "--context", env.contextPath],
      env.root,
    );
    assert.equal(blocked.status, 1);
    assert.equal(blocked.payload.code, "project_scan_incomplete");
    assert.equal(await fsp.readFile(path.join(central, "SKILL.md"), "utf8").then(Boolean), true);
  } finally {
    await fsp.rename(offlineConfig, env.codexConfig);
  }
  assert.equal(await fsp.realpath(target), await fsp.realpath(central));
});

test("remove 在期望分配的全局或项目映射根缺失时停止", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "expected-root-remove");
  const added = runCli(
    ["project-add", "--path", env.project, "--context", env.contextPath],
    env.root,
  );
  assert.equal(added.status, 0, added.stderr);
  const projectId = added.payload.project.id;
  for (const args of [
    ["assign", "expected-root-remove", "--scope", "global", "--context", env.contextPath],
    [
      "assign",
      "expected-root-remove",
      "--scope",
      "project",
      "--project",
      projectId,
      "--context",
      env.contextPath,
    ],
  ]) {
    const assigned = runCli(args, env.root);
    assert.equal(assigned.status, 0, assigned.stderr);
  }

  const projectSkillsRoot = path.join(env.project, ".codex", "skills");
  const offlineGlobal = `${env.globalTarget}.offline`;
  const offlineProject = `${projectSkillsRoot}.offline`;
  const contextBefore = await fsp.readFile(env.contextPath, "utf8");
  await fsp.rename(env.globalTarget, offlineGlobal);
  await fsp.rename(projectSkillsRoot, offlineProject);
  try {
    const preview = runCli(
      ["remove", "expected-root-remove", "--dry-run", "--context", env.contextPath],
      env.root,
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.payload.scanComplete, false);
    assert.equal(preview.payload.executable, false);
    assert.equal(
      preview.payload.blockedProjects.filter(
        (project) => project.code === "mapping_root_unavailable",
      ).length,
      2,
    );
    assert.equal(
      preview.payload.actions.some((action) => action.action === "remove-central"),
      false,
    );

    const blocked = runCli(
      ["remove", "expected-root-remove", "--force", "--context", env.contextPath],
      env.root,
    );
    assert.equal(blocked.status, 1);
    assert.equal(blocked.payload.code, "project_scan_incomplete");
    assert.equal(await fsp.readFile(env.contextPath, "utf8"), contextBefore);
    assert.equal(await fsp.readFile(path.join(central, "SKILL.md"), "utf8").then(Boolean), true);
  } finally {
    await fsp.rename(offlineGlobal, env.globalTarget);
    await fsp.rename(offlineProject, projectSkillsRoot);
  }
  assert.equal(
    await fsp.realpath(path.join(env.globalTarget, "expected-root-remove")),
    await fsp.realpath(central),
  );
  assert.equal(
    await fsp.realpath(path.join(projectSkillsRoot, "expected-root-remove")),
    await fsp.realpath(central),
  );
});

test("批量暂存映射中途失败时恢复先前 Junction", async (t) => {
  const env = await fixture(t);
  const central = await createSkill(env.warehouse, "mapping-transaction");
  const first = path.join(env.globalTarget, "first-link");
  const conflict = path.join(env.globalTarget, "second-link");
  await fsp.symlink(central, first, process.platform === "win32" ? "junction" : "dir");
  await createSkill(env.globalTarget, "second-link");

  await assert.rejects(
    stageManagedMappings([first, conflict], env.warehouse),
    /拒绝移除非中央仓库映射/,
  );
  assert.equal(await fsp.realpath(first), await fsp.realpath(central));
  assert.equal(await fsp.readFile(path.join(conflict, "SKILL.md"), "utf8").then(Boolean), true);
});

test("并发 assign 通过 context 锁串行提交，不丢失更新", async (t) => {
  const env = await fixture(t);
  const names = Array.from({ length: 6 }, (_, index) => `concurrent-${index + 1}`);
  await Promise.all(names.map((name) => createSkill(env.warehouse, name)));

  const results = await Promise.all(
    names.map((name) =>
      runCliAsync(
        ["assign", name, "--scope", "global", "--context", env.contextPath],
        env.root,
      ),
    ),
  );
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
  assert.deepEqual(context.globalSkills, names);
  for (const name of names) {
    assert.equal(
      await fsp.realpath(path.join(env.globalTarget, name)),
      await fsp.realpath(path.join(env.warehouse, name)),
    );
  }
});

test("陈旧的空锁或截断 owner 锁会被保守恢复", async (t) => {
  const env = await fixture(t);
  await Promise.all([
    createSkill(env.warehouse, "stale-lock-empty"),
    createSkill(env.warehouse, "stale-lock-invalid"),
  ]);
  const lockPath = `${env.contextPath}.forklift.lock`;
  const staleTime = new Date(Date.now() - 60_000);

  await fsp.writeFile(lockPath, "", "utf8");
  await fsp.utimes(lockPath, staleTime, staleTime);
  const emptyRecovered = runCli(
    ["assign", "stale-lock-empty", "--scope", "global", "--context", env.contextPath],
    env.root,
  );
  assert.equal(emptyRecovered.status, 0, emptyRecovered.stderr);
  await assert.rejects(fsp.lstat(lockPath), { code: "ENOENT" });

  await fsp.writeFile(lockPath, "{}", "utf8");
  await fsp.utimes(lockPath, staleTime, staleTime);
  const invalidRecovered = runCli(
    ["assign", "stale-lock-invalid", "--scope", "global", "--context", env.contextPath],
    env.root,
  );
  assert.equal(invalidRecovered.status, 0, invalidRecovered.stderr);
  await assert.rejects(fsp.lstat(lockPath), { code: "ENOENT" });
  assert.equal(
    (await fsp.readdir(env.root)).some((name) => name.includes(".forklift.lock.candidate-")),
    false,
  );
});

test(
  "中央文件被独占时 remove 不会留下 context 与公开路径漂移",
  { skip: process.platform !== "win32" },
  async (t) => {
    const env = await fixture(t);
    await createSkill(env.warehouse, "locked-remove");
    const assigned = runCli(
      ["assign", "locked-remove", "--scope", "global", "--context", env.contextPath],
      env.root,
    );
    assert.equal(assigned.status, 0, assigned.stderr);
    const central = path.join(env.warehouse, "locked-remove");
    const target = path.join(env.globalTarget, "locked-remove");
    const manifest = path.join(central, "SKILL.md").replaceAll("'", "''");
    const holder = spawn(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$stream=[System.IO.File]::Open('${manifest}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None);[Console]::Out.WriteLine('ready');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null;$stream.Dispose()`,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    holder.stdout.setEncoding("utf8");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待独占文件锁超时")), 5_000);
      holder.stdout.on("data", (chunk) => {
        if (!chunk.includes("ready")) return;
        clearTimeout(timer);
        resolve();
      });
      holder.once("error", reject);
    });

    let removed;
    try {
      removed = runCli(
        ["remove", "locked-remove", "--force", "--context", env.contextPath],
        env.root,
      );
    } finally {
      holder.stdin.write("\n");
      holder.stdin.end();
      await new Promise((resolve) => holder.once("close", resolve));
    }

    const context = JSON.parse(await fsp.readFile(env.contextPath, "utf8"));
    if (removed.status === 0) {
      assert.equal(context.globalSkills.includes("locked-remove"), false);
      await assert.rejects(fsp.lstat(target), { code: "ENOENT" });
      await assert.rejects(fsp.lstat(central), { code: "ENOENT" });
    } else {
      assert.ok(context.globalSkills.includes("locked-remove"));
      assert.equal(await fsp.realpath(target), await fsp.realpath(central));
      assert.equal(await fsp.readFile(path.join(central, "SKILL.md"), "utf8").then(Boolean), true);
    }
  },
);
