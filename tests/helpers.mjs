import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { command, atomicJson } from '../src/util.mjs';
import { DEFAULTS, loadConfig } from '../src/config.mjs';
import { Repo } from '../src/git.mjs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';

export class FakeSubagents {
  constructor(worker) { this.calls = []; this.worker = worker; this.review = null; }
  async ping() { return { version: 1 }; }
  register() {}
  async delegate(req) {
    this.calls.push(req); const role = req.agent.replace('longtask-', '');
    const id = req.nodeId.split('-')[0]; let value;
    if (role === 'preflight') value = { summary: 'Read the plan', questions: [], risks: [] };
    else if (role === 'scout') value = { summary: 'Inspect changes directory', files: [], risks: [] };
    else if (role === 'worker') {
      if (this.worker) value = await this.worker(req, this.calls);
      else { await fs.mkdir(path.join(req.cwd, 'changes'), { recursive: true }); await fs.writeFile(path.join(req.cwd, 'changes', `${id}.txt`), 'implemented\n'); }
      value ??= { status: 'done', summary: 'Implemented', tests: [], blockers: [] };
    } else value = this.review ? await this.review(req) : { verdict: 'pass', summary: 'Reviewed', findings: [] };
    return { requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: 'completed', result: { kind: 'structured', value }, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1, toolCalls: 1, durationMs: 1 } };
  }
}
export class FakeGitLab {
  constructor() { this.identity = { host: 'gitlab.example.test', project: 'acme/demo' }; this.project = { id: 123 }; this.mrs = new Map(); this.checks = []; }
  async ensureMr(wp) {
    if (!this.mrs.has(wp.branch)) this.mrs.set(wp.branch, { iid: this.mrs.size + 1, url: `https://gitlab.example.test/acme/demo/-/merge_requests/${this.mrs.size + 1}`, target: wp.target });
    return this.mrs.get(wp.branch);
  }
  async check(wp) {
    this.checks.push({ branch: wp.branch, sha: wp.commit });
    return { state: 'success', pipeline: { id: 42, sha: wp.commit, status: 'success', web_url: 'https://gitlab.example.test/pipeline/42' }, jobs: [] };
  }
}
export async function fixture(t, { count = 2, configPatch = {}, worker } = {}) {
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-longtask-test-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); const remote = path.join(temp, 'remote.git');
  await fs.mkdir(root); await command(['git', 'init', '--bare', remote], { cwd: temp });
  await command(['git', 'init', '-b', 'main'], { cwd: root });
  await command(['git', 'config', 'user.name', 'Longtask Test'], { cwd: root });
  await command(['git', 'config', 'user.email', 'test@example.test'], { cwd: root });
  await command(['git', 'remote', 'add', 'origin', remote], { cwd: root });
  const plan = path.join(root, 'plans', 'arch'); await fs.mkdir(plan, { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await fs.writeFile(path.join(plan, 'decisions.md'), '# Decisions\nAll tests use isolated fixture data.\n');
  const workPackages = Array.from({ length: count }, (_, i) => { const id = `WP${String(i).padStart(2, '0')}`; return { id, file: `${id}.md` }; });
  for (const w of workPackages) await fs.writeFile(path.join(plan, w.file), `# ${w.id}\nImplement the scoped fixture change.\n`);
  const config = { ...structuredClone(DEFAULTS), id: 'arch', baseBranch: 'main', branchPrefix: 'longtask/arch', worktreeRoot: '../trees', workPackages, checks: [{ name: 'fixture check', command: [process.execPath, '-e', 'process.exit(0)'] }], ...configPatch };
  const configPath = path.join(plan, 'longtask.json'); await atomicJson(configPath, config);
  await command(['git', 'add', '.'], { cwd: root }); await command(['git', 'commit', '-m', 'base'], { cwd: root }); await command(['git', 'push', '-u', 'origin', 'main'], { cwd: root });
  const repo = await Repo.open(root); const subagents = new FakeSubagents(worker); const gitlab = new FakeGitLab(); const notices = [];
  async function engine() {
    const loaded = await loadConfig(configPath, root); const store = new Store(repo, config.id); await store.load(configPath);
    return new Engine({ repo, loaded, store, subagents, notify: text => notices.push(text), gitlabFactory: async () => gitlab });
  }
  const e = await engine(); await e.preflight(); await e.approve(async () => true);
  return { temp, root, remote, plan, configPath, config, repo, subagents, gitlab, e, engine, notices };
}
export function bus() {
  const listeners = new Map();
  return {
    on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
    emit(name, value) { for (const fn of [...(listeners.get(name) ?? [])]) fn(value); },
    listenerCount(name) { return listeners.get(name)?.size ?? 0; },
  };
}
