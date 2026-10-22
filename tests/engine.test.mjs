import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { exists, readJson } from '../src/util.mjs';

test('two-WP campaign creates a real stacked Git history, passing receipts and clean cleanup', async t => {
  const f = await fixture(t); await f.e.run(); const s = f.e.state;
  assert.equal(s.status, 'completed'); assert.equal(s.current, 2); assert.equal(f.gitlab.mrs.size, 2);
  const [a, b] = s.workPackages; assert.equal(a.target, 'refactor/arch'); assert.equal(b.target, a.branch);
  assert.equal(b.baseSha, a.commit); assert.equal(await f.repo.text(['rev-parse', `${b.commit}^`]), a.commit);
  for (const w of s.workPackages) {
    assert.equal(w.ci.sourceSha, w.commit); assert.equal(w.review.tree, w.local.tree);
    assert.equal(await f.repo.remoteSha('origin', w.branch), w.commit); assert.equal(await exists(w.worktree), false);
    assert.equal((await readJson(w.checkpoint)).commit, w.commit);
  }
  await f.repo.assertClean(); assert.equal((await f.repo.listWorktrees()).length, 1);
  assert.equal(f.subagents.calls.filter(r => r.agent === 'longtask-worker').length, 2);
});
test('--one stops at a durable WP boundary and a new engine resumes the remainder', async t => {
  const f = await fixture(t); await f.e.run({ one: true }); assert.equal(f.e.state.status, 'paused'); assert.equal(f.e.state.current, 1);
  const next = await f.engine(); await next.run(); assert.equal(next.state.status, 'completed'); assert.equal(f.gitlab.mrs.size, 2);
});
test('commit crash recovery adopts only the recorded parent/tree and does not commit twice', async t => {
  const f = await fixture(t, { count: 1 }); const original = f.repo.commit.bind(f.repo);
  f.repo.commit = async (...args) => { await original(...args); throw new Error('simulated crash after commit'); };
  await assert.rejects(f.e.run(), /simulated crash/); assert.equal(f.e.state.workPackages[0].phase, 'commit');
  f.repo.commit = original; const next = await f.engine(); await next.run();
  const w = next.state.workPackages[0]; assert.equal(next.state.status, 'completed');
  assert.equal(await f.repo.text(['rev-list', '--count', `${w.baseSha}..${w.commit}`]), '1');
  assert.equal(f.subagents.calls.filter(r => r.agent === 'longtask-worker').length, 1);
});
test('MR creation crash is reconciled without creating a duplicate MR', async t => {
  const f = await fixture(t, { count: 1 }); const original = f.gitlab.ensureMr.bind(f.gitlab); let once = true;
  f.gitlab.ensureMr = async (...args) => { const mr = await original(...args); if (once) { once = false; throw new Error('network lost after MR creation'); } return mr; };
  await assert.rejects(f.e.run(), /network lost/); assert.equal(f.gitlab.mrs.size, 1);
  const next = await f.engine(); await next.run(); assert.equal(f.gitlab.mrs.size, 1); assert.equal(next.state.status, 'completed');
});
test('failed local checks delegate a repair and never publish unverified code', async t => {
  let workers = 0;
  const f = await fixture(t, { count: 1,
    configPatch: { checks: [{ name: 'content check', command: [process.execPath, '-e', "process.exit(require('fs').readFileSync('answer.txt','utf8')==='correct'?0:1)"] }] },
    worker: async req => { workers++; await fs.writeFile(path.join(req.cwd, 'answer.txt'), workers === 1 ? 'wrong' : 'correct'); },
  });
  await f.e.run(); assert.equal(workers, 2); assert.equal(f.e.state.workPackages[0].repairs, 1); assert.equal(f.gitlab.mrs.size, 1);
});
test('blocking review findings lead to bounded fixes, never green completion by declaration', async t => {
  const f = await fixture(t, { count: 1 });
  f.subagents.review = async () => ({ verdict: 'changes_requested', summary: 'A concrete issue remains', findings: [{ severity: 'blocking', file: 'changes/WP00.txt', line: 1, issue: 'Fixture invariant missing', fix: 'Implement required invariant' }] });
  await assert.rejects(f.e.run(), /no code progress/); assert.equal(f.gitlab.mrs.size, 0);
  assert.equal(f.e.state.status, 'blocked'); assert.ok(await exists(f.e.state.workPackages[0].worktree));
});
test('an unconfigured browser gate blocks client changes', async t => {
  const f = await fixture(t, { count: 1, worker: async req => { await fs.writeFile(path.join(req.cwd, 'View.tsx'), 'export const View=()=>null;\n'); } });
  await assert.rejects(f.e.run(), /uiChecks is empty/); assert.equal(f.gitlab.mrs.size, 0);
});
test('client changes execute the configured browser check and record its receipt', async t => {
  const f = await fixture(t, { count: 1, configPatch: { uiChecks: [{ name: 'browser fixture', command: [process.execPath, '-e', 'process.exit(0)'] }] }, worker: async req => { await fs.writeFile(path.join(req.cwd, 'View.tsx'), 'export const View=()=>null;\n'); } });
  await f.e.run(); const w = f.e.state.workPackages[0]; assert.equal(w.local.uiRequired, true); assert.ok(w.local.receipts.some(r => r.name === 'browser fixture'));
});
test('plan drift after approval blocks before implementation', async t => {
  const f = await fixture(t, { count: 1 }); await fs.appendFile(path.join(f.plan, 'WP00.md'), '\nChanged requirements\n');
  await assert.rejects(f.e.run(), /changed/); assert.equal(f.subagents.calls.filter(r => r.agent === 'longtask-worker').length, 0);
});
test('worker cannot modify the approved specification in its own checkout', async t => {
  const f = await fixture(t, { count: 1, worker: async req => { await fs.appendFile(path.join(req.cwd, 'plans/arch/WP00.md'), '\nFake completion\n'); } });
  await assert.rejects(f.e.run(), /Approved campaign input/); assert.equal(f.gitlab.mrs.size, 0);
});
test('sensitive files fail before git staging or remote publication', async t => {
  const f = await fixture(t, { count: 1, worker: async req => { await fs.writeFile(path.join(req.cwd, '.env'), 'SECRET=not-real'); } });
  await assert.rejects(f.e.run(), /Sensitive file blocked/); assert.equal(f.gitlab.mrs.size, 0);
  assert.equal(await f.repo.text(['diff', '--cached', '--name-only'], f.e.state.workPackages[0].worktree), '');
});
test('unresolved child attempts block resume without spawning a replacement', async t => {
  const f = await fixture(t, { count: 1 }); f.e.state.activeAttempts.old = { role: 'worker', uncertain: true }; await f.e.store.save();
  await assert.rejects(f.e.run(), /earlier child/); assert.equal(f.subagents.calls.length, 1);
});
test('existing unowned branches are never adopted', async t => {
  const f = await fixture(t, { count: 1 }); await f.repo.git(['branch', 'dev/refactor-arch/00']);
  await assert.rejects(f.e.run(), /already exists/); assert.equal(f.gitlab.mrs.size, 0);
});
test('verification that mutates tracked source does not receive a green receipt', async t => {
  const f = await fixture(t, { count: 1, configPatch: { checks: [{ name: 'bad mutating check', command: [process.execPath, '-e', "require('fs').appendFileSync('README.md','changed')"] }] } });
  await assert.rejects(f.e.run(), /modified source files/); assert.equal(f.gitlab.mrs.size, 0);
});
test('CI failure repairs the same branch/MR and reruns all local and review gates', async t => {
  let workers = 0;
  const f = await fixture(t, { count: 1, worker: async req => { workers++; await fs.writeFile(path.join(req.cwd, 'answer.txt'), `revision ${workers}`); } });
  const original = f.gitlab.check.bind(f.gitlab); let first = true;
  f.gitlab.check = async wp => {
    if (first) { first = false; return { state: 'repair', reason: 'CI failed', pipeline: { id: 10, sha: wp.commit, status: 'failed' }, logs: [{ job: 'test', trace: 'fixture CI failure' }] }; }
    return original(wp);
  };
  await f.e.run(); assert.equal(workers, 2); assert.equal(f.gitlab.mrs.size, 1);
  assert.equal(f.subagents.calls.filter(r => r.agent === 'longtask-correctness').length, 2);
  assert.equal(await f.repo.text(['rev-list', '--count', `${f.e.state.workPackages[0].baseSha}..${f.e.state.workPackages[0].commit}`]), '2');
});
test('resume rejects an earlier completed branch that moved outside the controller', async t => {
  const f = await fixture(t); await f.e.run({ one: true });
  const first = f.e.state.workPackages[0];
  await f.repo.git(['update-ref', `refs/heads/${first.branch}`, first.baseSha]);
  const next = await f.engine();
  await assert.rejects(next.run(), /Completed local branch.*moved/);
  assert.equal(f.subagents.calls.filter(r => r.agent === 'longtask-worker').length, 1);
});
