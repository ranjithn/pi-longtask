import { command, invariant } from './util.mjs';

export function remoteIdentity(raw) {
  let host, project;
  if (/^[a-z]+:\/\//i.test(raw)) {
    const url = new URL(raw); invariant(['ssh:', 'http:', 'https:'].includes(url.protocol), 'GitLab remote must use SSH or HTTPS');
    host = url.hostname + ((url.protocol === 'https:' || url.protocol === 'http:') && url.port ? `:${url.port}` : '');
    project = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } else {
    const m = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw); invariant(m, 'Cannot infer GitLab host/project from remote URL. Use an SSH or HTTPS GitLab remote, not a local path.');
    [, host, project] = m;
  }
  project = project.replace(/\.git\/?$/, '').replace(/\/$/, '');
  invariant(/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host) && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(project), 'Unsupported GitLab remote host/project');
  return { host, project };
}
export function assertMr(mr, wp, projectId) {
  invariant(mr && mr.source_branch === wp.branch && mr.target_branch === wp.target, 'MR has incorrect source/target branches');
  invariant(mr.source_project_id === projectId && mr.target_project_id === projectId, 'Cross-project/fork MRs are not supported');
  invariant(mr.state === 'opened', `MR !${mr.iid} is ${mr.state}; no automatic reopen or merge`);
}
export function classifyPipeline(pipeline, sha) {
  if (!pipeline) return { state: 'wait', reason: 'No pipeline for the current commit yet' };
  if (pipeline.sha !== sha) return { state: 'wait', reason: 'Pipeline SHA does not match the pushed commit (merged-result-only pipelines require manual handling)' };
  if (pipeline.status === 'success') return { state: 'success' };
  if (pipeline.status === 'failed') return { state: 'repair', reason: 'CI failed' };
  if (['canceled', 'skipped', 'manual'].includes(pipeline.status)) return { state: 'blocked', reason: `CI is ${pipeline.status}; it is not a passing gate` };
  if (['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled'].includes(pipeline.status)) return { state: 'wait', reason: `CI ${pipeline.status}` };
  return { state: 'blocked', reason: `Unknown CI state: ${pipeline.status}` };
}
export class GitLab {
  constructor(repo, identity, runner = command) { this.repo = repo; this.identity = identity; this.runner = runner; }
  static async connect(repo, remote, signal, runner = command) {
    const url = await repo.text(['remote', 'get-url', '--push', remote]);
    const identity = remoteIdentity(url); const client = new GitLab(repo, identity, runner);
    const project = await client.api(`projects/${encodeURIComponent(identity.project)}`, 'GET', {}, signal);
    invariant(Number.isSafeInteger(project.id) && project.path_with_namespace === identity.project, 'GitLab project identity does not match the push remote');
    client.project = project; return client;
  }
  async api(endpoint, method = 'GET', fields = {}, signal, text = false) {
    const argv = ['glab', 'api', endpoint, '--hostname', this.identity.host, '--method', method];
    for (const [k, v] of Object.entries(fields)) argv.push(typeof v === 'boolean' || typeof v === 'number' ? '--field' : '--raw-field', `${k}=${v}`);
    const r = await this.runner(argv, { cwd: this.repo.root, signal, timeoutMs: 90000, maxBytes: 8 * 1024 * 1024 });
    return text ? r.stdout : JSON.parse(r.stdout);
  }
  endpoint(tail) { return `projects/${this.project.id}/${tail}`; }
  async pages(tail, signal) {
    const all = []; const sep = tail.includes('?') ? '&' : '?';
    for (let page = 1; page <= 20; page++) {
      const rows = await this.api(this.endpoint(`${tail}${sep}per_page=100&page=${page}`), 'GET', {}, signal);
      invariant(Array.isArray(rows), 'Expected paged GitLab array'); all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw new Error('GitLab pagination exceeds safety bound (2000 rows); narrow the query');
  }
  async ensureMr(wp, title, description, signal) {
    const matches = await this.pages(`merge_requests?state=all&source_branch=${encodeURIComponent(wp.branch)}`, signal);
    invariant(matches.length <= 1, 'Multiple MRs use this source branch; refusing ambiguous recovery');
    let mr = matches[0];
    if (!mr) {
      mr = await this.api(this.endpoint('merge_requests'), 'POST', {
        source_branch: wp.branch, target_branch: wp.target, title, description,
        remove_source_branch: false, squash: false,
      }, signal);
    }
    // Always GET: list/create DTOs can omit relevant fields.
    mr = await this.api(this.endpoint(`merge_requests/${mr.iid}`), 'GET', {}, signal);
    assertMr(mr, wp, this.project.id);
    return { iid: mr.iid, url: mr.web_url, target: mr.target_branch };
  }
  async check(wp, config, signal) {
    const mr = await this.api(this.endpoint(`merge_requests/${wp.mr.iid}`), 'GET', {}, signal);
    assertMr(mr, wp, this.project.id);
    if (mr.sha !== wp.commit) return { state: 'wait', reason: 'MR has not indexed the current source commit' };
    invariant(!mr.has_conflicts, 'MR has merge conflicts; automatic rebasing is disabled');
    let pipeline = mr.head_pipeline;
    if (!pipeline) {
      const candidates = await this.pages(`pipelines?sha=${wp.commit}&ref=${encodeURIComponent(wp.branch)}&order_by=id&sort=desc`, signal);
      pipeline = candidates.filter(p => p.sha === wp.commit).sort((a, b) => b.id - a.id)[0];
    }
    const status = classifyPipeline(pipeline, wp.commit);
    if (status.state === 'wait' || status.state === 'blocked') return { ...status, pipeline };
    const jobs = await this.pages(`pipelines/${pipeline.id}/jobs?include_retried=false`, signal);
    if (status.state === 'success') {
      for (const required of config.requiredJobs) {
        const job = jobs.filter(j => j.name === required).sort((a, b) => b.id - a.id)[0];
        invariant(job?.status === 'success', `Required CI job '${required}' is missing or not successful`);
      }
    }
    const logs = [];
    if (status.state === 'repair') {
      for (const job of jobs.filter(j => j.status === 'failed' && !j.allow_failure).slice(0, 5)) {
        let trace;
        try { trace = await this.api(this.endpoint(`jobs/${job.id}/trace`), 'GET', {}, signal, true); }
        catch (e) { if (signal?.aborted) throw e; trace = `Trace unavailable: ${e.message}`; }
        logs.push({ job: job.name, id: job.id, trace: trace.slice(-60000) });
      }
    }
    return { ...status, pipeline, jobs: jobs.map(j => ({ id: j.id, name: j.name, status: j.status, allow_failure: j.allow_failure })), logs };
  }
}
