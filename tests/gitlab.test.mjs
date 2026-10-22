import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLab } from '../src/gitlab.mjs';

const wp = { branch: 'dev/refactor/00', target: 'refactor/arch', commit: 'a'.repeat(40), mr: { iid: 7 } };
const mr = () => ({ iid: 7, source_branch: wp.branch, target_branch: wp.target, source_project_id: 19, target_project_id: 19, state: 'opened', sha: wp.commit, has_conflicts: false, web_url: 'https://gitlab.example.test/acme/repo/-/merge_requests/7', head_pipeline: { id: 9, sha: wp.commit, status: 'success' } });
function client(handler) {
  const calls = [];
  const c = new GitLab({ root: '/tmp' }, { host: 'gitlab.example.test', project: 'acme/repo' }, async (argv, opts) => {
    calls.push({ argv, opts }); const result = await handler(argv[2], argv);
    return { stdout: typeof result === 'string' ? result : JSON.stringify(result), stderr: '', code: 0 };
  });
  c.project = { id: 19 }; return { c, calls };
}
test('GitLab creation uses explicit host, typed booleans, and re-reads the MR', async () => {
  const { c, calls } = client(async (endpoint, argv) => {
    if (endpoint.includes('state=all')) return [];
    if (argv[argv.indexOf('--method') + 1] === 'POST') return { iid: 7 };
    return mr();
  });
  const result = await c.ensureMr(wp, 'WP00', 'approved');
  assert.equal(result.iid, 7); assert.equal(calls.length, 3);
  const post = calls[1].argv;
  assert.ok(post.includes('remove_source_branch=false')); assert.ok(post.includes('squash=false'));
  assert.equal(post[post.indexOf('squash=false') - 1], '--field');
  assert.equal(post[post.indexOf('--hostname') + 1], 'gitlab.example.test');
});
test('GitLab duplicate recovery reuses an existing MR and rejects a wrong target', async () => {
  let wrong = false;
  const { c, calls } = client(async endpoint => endpoint.includes('state=all') ? [{ iid: 7 }] : { ...mr(), target_branch: wrong ? 'main' : wp.target });
  await c.ensureMr(wp, 'WP00', 'approved');
  assert.ok(calls.every(x => !x.argv.includes('POST')));
  wrong = true; await assert.rejects(c.ensureMr(wp, 'WP00', 'approved'), /incorrect source\/target/);
});
test('successful pipeline with a missing mandatory job is not accepted', async () => {
  const { c } = client(async endpoint => endpoint.includes('/jobs?') ? [{ id: 100, name: 'build', status: 'success' }] : mr());
  await assert.rejects(c.check(wp, { requiredJobs: ['playwright'] }), /Required CI job 'playwright'/);
});
test('merged-results synthetic SHA never passes the source-commit gate', async () => {
  const { c, calls } = client(async () => ({ ...mr(), head_pipeline: { id: 9, sha: 'b'.repeat(40), status: 'success' } }));
  const result = await c.check(wp, { requiredJobs: [] });
  assert.equal(result.state, 'wait'); assert.equal(calls.length, 1);
});
test('failed pipeline gathers bounded traces without running model-facing shell strings', async () => {
  const { c } = client(async endpoint => {
    if (endpoint.endsWith('/trace')) return 'failure details\n';
    if (endpoint.includes('/jobs?')) return [{ id: 100, name: 'test', status: 'failed', allow_failure: false }];
    return { ...mr(), head_pipeline: { id: 9, sha: wp.commit, status: 'failed' } };
  });
  const result = await c.check(wp, { requiredJobs: [] });
  assert.equal(result.state, 'repair'); assert.match(result.logs[0].trace, /failure details/);
});
test('GitLab pagination reads beyond the first page', async () => {
  const { c, calls } = client(async endpoint => endpoint.endsWith('page=1') ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }]);
  assert.equal((await c.pages('merge_requests?state=all')).length, 101);
  assert.equal(calls.length, 2);
});
