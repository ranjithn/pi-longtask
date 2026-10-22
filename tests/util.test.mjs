import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, atomicJson, command, matchGlob, readJson, relativePath, splitArgs, within } from '../src/util.mjs';
import { DEFAULTS, validateConfig, discoverWps } from '../src/config.mjs';
import { remoteIdentity, classifyPipeline, assertMr } from '../src/gitlab.mjs';
import { SCHEMAS, validateResult } from '../src/prompts.mjs';

test('glob language matches both root and nested UI files without regex injection', () => {
  assert.ok(matchGlob('**/*.tsx', 'App.tsx')); assert.ok(matchGlob('**/*.tsx', 'a/b/App.tsx'));
  assert.ok(!matchGlob('**/*.tsx', 'a/b/App.ts')); assert.ok(matchGlob('client/**', 'client/a/x.ts'));
  assert.ok(matchGlob('a[1].md', 'a[1].md')); assert.ok(!matchGlob('*.md', 'x/a.md'));
});
test('argument parser preserves quoted paths and rejects unfinished quotes', () => {
  assert.deepEqual(splitArgs('init "plans/big task" --from WP00'), ['init', 'plans/big task', '--from', 'WP00']);
  assert.throws(() => splitArgs('init "unfinished')); assert.deepEqual(splitArgs('init a\\ b'), ['init', 'a b']);
});
test('path confinement rejects parent traversal and misleading prefix matches', () => {
  assert.ok(within('/x/root', '/x/root/a')); assert.ok(!within('/x/root', '/x/root-other'));
  assert.throws(() => relativePath('../outside', 'test'));
});
test('atomic JSON and repository locks preserve single-controller ownership', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'longtask-lock-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'); await atomicJson(file, { n: 1 }); await atomicJson(file, { n: 2 }); assert.equal((await readJson(file)).n, 2);
  const lock = path.join(dir, 'lock'); const release = await acquireLock(lock, { campaign: 'test' });
  await assert.rejects(acquireLock(lock, {}), /locked/); await release(); const second = await acquireLock(lock, {}); await second();
});
test('host command timeout fails closed and kills its process group', async () => {
  const result = await command([process.execPath, '-e', 'setInterval(()=>{}, 1000)'], { timeoutMs: 40, allowFailure: true });
  assert.ok(result.timedOut); assert.notEqual(result.code, 0);
});
test('abort signal cancels a host command without reporting success', async () => {
  const c = new AbortController(); setTimeout(() => c.abort(new Error('owner stop')), 40);
  await assert.rejects(command([process.execPath, '-e', 'setInterval(()=>{}, 1000)'], { signal: c.signal }), /owner stop/);
});
test('config rejects implicit shell commands, unbounded limits and writable reviewers', () => {
  const c = { ...structuredClone(DEFAULTS), id: 'x', baseBranch: 'main', branchPrefix: 'dev/x', worktreeRoot: '../wt', workPackages: [{ id: 'WP00', file: 'WP00.md' }] };
  assert.equal(validateConfig(c).id, 'x');
  assert.throws(() => validateConfig({ ...c, checks: [{ name: 'test', command: 'npm test' }] }));
  assert.throws(() => validateConfig({ ...c, limits: { maxAgentCallsPerWp: -1 } }));
  assert.throws(() => validateConfig({ ...c, agents: { reviewerTools: ['bash'] } }));
  assert.throws(() => validateConfig({ ...c, magicalSetting: true }));
});
test('WP discovery sorts numeric IDs and refuses ambiguous or missing packages', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'longtask-plan-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of ['WP02-tests.md', 'WP00.md', 'WP01.md']) await fs.writeFile(path.join(dir, name), '# WP');
  assert.deepEqual((await discoverWps(dir, 'WP00', 'WP02')).map(x => x.id), ['WP00', 'WP01', 'WP02']);
  await assert.rejects(discoverWps(dir, 'WP00', 'WP03'), /Missing WP03/);
  await fs.writeFile(path.join(dir, 'WP01-alternative.md'), 'duplicate'); await assert.rejects(discoverWps(dir), /Ambiguous WP01/);
});
test('GitLab project identity is tied to the push remote', () => {
  assert.deepEqual(remoteIdentity('git@gitlab.example.com:group/sub/repo.git'), { host: 'gitlab.example.com', project: 'group/sub/repo' });
  assert.deepEqual(remoteIdentity('https://gitlab.example.com:8443/group/repo.git'), { host: 'gitlab.example.com:8443', project: 'group/repo' });
  assert.throws(() => remoteIdentity('/tmp/remote.git'));
});
test('CI cannot pass for a stale SHA, missing pipeline or skipped/manual job state', () => {
  assert.equal(classifyPipeline({ sha: 'old', status: 'success' }, 'new').state, 'wait');
  assert.equal(classifyPipeline(null, 'new').state, 'wait');
  for (const status of ['skipped', 'manual', 'canceled']) assert.equal(classifyPipeline({ sha: 'new', status }, 'new').state, 'blocked');
  assert.equal(classifyPipeline({ sha: 'new', status: 'failed' }, 'new').state, 'repair');
  assert.equal(classifyPipeline({ sha: 'new', status: 'success' }, 'new').state, 'success');
});
test('MR validation refuses the wrong target, closed MRs and cross-project forks', () => {
  const wp = { branch: 'dev/00', target: 'main' }; const mr = { source_branch: 'dev/00', target_branch: 'main', source_project_id: 1, target_project_id: 1, state: 'opened' };
  assert.doesNotThrow(() => assertMr(mr, wp, 1));
  assert.throws(() => assertMr({ ...mr, target_branch: 'wrong' }, wp, 1));
  assert.throws(() => assertMr({ ...mr, state: 'closed' }, wp, 1));
  assert.throws(() => assertMr({ ...mr, source_project_id: 2 }, wp, 1));
});
test('review result validator rejects malformed or extra fields', () => {
  assert.doesNotThrow(() => validateResult(SCHEMAS.review, { verdict: 'pass', summary: 'ok', findings: [] }));
  assert.throws(() => validateResult(SCHEMAS.review, { verdict: 'pass' }));
  assert.throws(() => validateResult(SCHEMAS.review, { verdict: 'pass', summary: 'ok', findings: [], approve: true }));
});
