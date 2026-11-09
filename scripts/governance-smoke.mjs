import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';

const binary = resolve(process.argv[2] ?? `src-tauri/target/debug/skills-manager-cli${process.platform === 'win32' ? '.exe' : ''}`);
const tempRoot = realpathSync(tmpdir());
const fixture = mkdtempSync(join(tempRoot, 'skills-governance-smoke-'));
function run(args, expected = 0) {
  const result = spawnSync(binary, ['--skills-root', fixture, '--json', 'governance', ...args], { encoding: 'utf8' });
  assert.equal(result.status, expected, result.stderr || result.error?.message);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
try {
  mkdirSync(join(fixture, 'sample'));
  writeFileSync(join(fixture, 'sample/SKILL.md'), '---\nname: sample\ndescription: 用于验证命令行治理流程\n---\n测试正文\n');
  assert.equal(run(['inspect']).skills[0].state, 'unlocked');
  assert.equal(run(['verify'], 1).issues[0].code, 'lock_missing');
  assert.deepEqual(readdirSync(fixture), ['sample']);
  run(['lock'], 1);
  assert.deepEqual(readdirSync(fixture), ['sample']);
  assert.equal(run(['lock', '--yes']).locked_count, 1);
  assert.equal(run(['verify']).skills[0].state, 'locked');
  const firstLock = readFileSync(join(fixture, 'skills-manager.lock.json'), 'utf8');
  writeFileSync(join(fixture, 'sample/extra.txt'), 'changed');
  assert.equal(run(['verify'], 1).skills[0].state, 'changed');
  assert.equal(readFileSync(join(fixture, 'skills-manager.lock.json'), 'utf8'), firstLock);
  assert.equal(run(['lock', '--yes']).skills[0].state, 'locked');
  writeFileSync(join(fixture, 'skills-manager.lock.json'), '{"schema_version":999}');
  run(['lock', '--yes'], 1);
  assert.equal(readFileSync(join(fixture, 'skills-manager.lock.json'), 'utf8'), '{"schema_version":999}');
  console.log('通过：只读扫描、缺失基线、显式确认、建立基线、一致校验、内容变化、更新基线、未知格式保护。');
} finally {
  const actual = realpathSync(fixture);
  const child = relative(tempRoot, actual);
  assert.ok(!isAbsolute(child) && !child.startsWith('..') && child.startsWith('skills-governance-smoke-'));
  rmSync(actual, { recursive: true });
}
