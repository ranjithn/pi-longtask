import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLock, aborted, command, errorText, exists, invariant, noSymlinks, now, sleep, within } from './util.mjs';
import { hasUi, inputSnapshot, loadConfig } from './config.mjs';
import { GitLab } from './gitlab.mjs';
import { SCHEMAS, validateResult } from './prompts.mjs';

export class Engine {
  constructor({ repo, loaded, store, subagents, notify = () => {}, onCheckpoint = async () => {}, gitlabFactory = GitLab.connect, runner = command }) {
    Object.assign(this, { repo, loaded, store, subagents, notify, onCheckpoint, gitlabFactory, runner });
    this.config = loaded.config; this.state = store.state; this.pauseRequested = false;
  }
  async connect(signal) {
    await this.subagents.ping(); this.subagents.register(this.config.agents);
    const client = await this.gitlabFactory(this.repo, this.config.remote, signal);
    if (this.state.approval) {
      const a = this.state.approval;
      invariant(client.project.id === a.projectId && client.identity.host === a.host && client.identity.project === a.project, 'Push remote / GitLab project changed since approval');
    }
    this.gitlab = client;
  }
  async assertApproval() {
    invariant(this.state.approval, 'Run /longtask preflight and /longtask approve first');
    const current = await loadConfig(this.loaded.configPath, this.repo.root);
    const snapshot = await inputSnapshot(current, this.repo.root);
    this.gitConfig = { ...this.config, immutablePaths: ['AGENTS.md', ...Object.keys(snapshot.contents), path.relative(this.repo.root, this.loaded.configPath).replaceAll('\\', '/')] };
    invariant(snapshot.digest === this.state.approval.digest, 'Approved plan, decisions, AGENTS.md or config changed. Restore the approved inputs before resuming; do not silently change a running campaign.');
  }
  async approve(confirm, signal) {
    invariant(this.state.workPackages.length === 0, 'Approval is frozen once a campaign is initialized. Use a new campaign id for a revised plan.');
    invariant(this.state.preflight, 'Run /longtask preflight first and resolve the questions in decisions.md');
    invariant(Object.keys(this.state.activeAttempts).length === 0, 'An old attempt is unresolved; recover it before approving');
    for (const wp of this.config.workPackages) invariant(this.config.checks.length + (wp.checks?.length ?? 0) > 0, `Add at least one actual local test/check command for ${wp.id}; empty verification is not approval`);
    const snapshot = await inputSnapshot(this.loaded, this.repo.root);
    const baseSha = await this.repo.validateBase(this.config, signal);
    await this.connect(signal);
    const agreement = `Approve ${this.config.id}: ${this.config.workPackages.map(w => w.id).join(' → ')}?\n\nThis authorizes the configured setup/test commands, agent code edits in owned worktrees, commits, non-force pushes to ${this.config.remote}, and creation of stacked MRs in ${this.gitlab.identity.host}/${this.gitlab.identity.project}.\n\n${this.config.cleanup ? 'Clean owned worktrees will be removed after successful gates (including ignored build/dependency artifacts).' : 'Worktrees will be retained.'}\n\nNo MRs are merged, no branches deleted, and no automatic rebases. Confirm that decisions.md resolves the preflight questions and test commands cannot alter shared/production data.`;
    if (!await confirm(agreement)) return false;
    // Recheck after the dialog in case the user edited inputs while it was open.
    invariant((await inputSnapshot(await loadConfig(this.loaded.configPath, this.repo.root), this.repo.root)).digest === snapshot.digest, 'Inputs changed during approval; run approval again');
    const release = await acquireLock(this.store.lockFile, { campaign: this.config.id, action: 'approve' });
    try {
      await this.store.assertFresh();
      this.state.approval = { digest: snapshot.digest, baseSha, projectId: this.gitlab.project.id, host: this.gitlab.identity.host, project: this.gitlab.identity.project, at: now() };
      await this.store.snapshotInputs(snapshot);
      this.state.workPackages = this.config.workPackages.map(w => ({ id: w.id, status: 'pending', phase: 'prepare', calls: 0, allowanceCalls: 0, repairs: 0, noProgress: 0, costUsd: 0, unknownUsage: 0 }));
      this.state.status = 'ready'; this.state.error = null;
      await this.store.save({ type: 'approved', digest: snapshot.digest });
      this.notify('Approved. Start with /longtask run --one to exercise WP00 before the remainder.');
      return true;
    } finally { await release(); }
  }
  context(wpSpec, extra = '') {
    const planRel = path.relative(this.repo.root, this.loaded.planDir);
    const inputRoot = path.join(this.store.dir, 'inputs');
    const manifest = path.join(this.store.dir, 'inputs.json');
    return `Repository: ${this.repo.root}\nApproved input manifest: ${manifest}\nApproved specification snapshot root: ${inputRoot}\nRead ALL relevant approved inputs, including decisions: ${path.join(inputRoot, planRel, this.config.decisions)}\n${wpSpec ? `Assigned WP: ${wpSpec.id}\nRead the entire WP: ${path.join(inputRoot, planRel, wpSpec.file)}\n` : 'Read EVERY file in the input manifest, not just selected excerpts.\n'}Infrastructure constraints:\n${this.config.infrastructure}\n${extra}`;
  }
  async agent(role, task, cwd, wp, signal) {
    aborted(signal);
    if (wp) {
      invariant(wp.allowanceCalls < this.config.limits.maxAgentCallsPerWp, 'Agent-call allowance exhausted. Inspect progress before /longtask retry grants another bounded allowance.');
      if (this.config.limits.maxCostUsdPerWp !== null) {
        invariant(wp.unknownUsage === 0, 'Cost limit is configured but an earlier child has unknown usage; refusing to treat unknown cost as zero');
        invariant(wp.costUsd < this.config.limits.maxCostUsdPerWp, 'Recorded per-WP cost budget reached');
      }
      wp.calls++; wp.allowanceCalls++;
    }
    const requestId = randomUUID();
    const schema = SCHEMAS[role] ?? SCHEMAS.review;
    const nodeId = `${wp?.id ?? 'preflight'}-${role}-${requestId.slice(0, 8)}`;
    const ownerRunId = `longtask-${this.config.id}`;
    const request = {
      requestId, ownerRunId, nodeId, agent: `longtask-${role}`, task, cwd,
      context: 'fresh', thinking: this.config.agents.thinking,
      timeoutMs: this.config.limits.agentTimeoutMinutes * 60000,
      toolBudget: { hard: this.config.limits.maxToolCallsPerAgent, block: '*' },
      intercomBridge: { mode: 'off' }, artifacts: true, skill: false,
      result: { kind: 'structured', schema },
      ...(this.config.agents.models[role] ? { model: this.config.agents.models[role] } : {}),
    };
    this.state.activeAttempts[requestId] = { requestId, ownerRunId, nodeId, role, wp: wp?.id, cwd, startedAt: now() };
    await this.store.save({ type: 'agent-start', role, wp: wp?.id, requestId });
    this.notify(`${wp?.id ?? 'Plan'} · ${role}`);
    let response;
    try {
      response = await this.subagents.delegate(request, { signal, onUpdate: event => {
        if (event.currentTool) this.notify(`${wp?.id ?? 'Plan'} · ${role} · ${event.currentTool}`, { transient: true });
      } });
    } catch (e) {
      // No terminal acknowledgement: preserve the attempt so resume cannot overlap it.
      this.state.activeAttempts[requestId].uncertain = true;
      await this.store.save({ type: 'agent-unconfirmed', requestId, error: errorText(e) });
      throw e;
    }
    const file = await this.store.artifact(`${wp?.id ?? 'plan'}-${role}-${requestId}.json`, response);
    delete this.state.activeAttempts[requestId];
    if (wp) {
      if (Number.isFinite(response.usage?.cost) && response.usage.cost >= 0) wp.costUsd += response.usage.cost;
      else wp.unknownUsage++;
    }
    await this.store.save({ type: 'agent-end', role, wp: wp?.id, requestId, status: response.status, artifact: file });
    aborted(signal);
    invariant(response.status === 'completed', `Subagent ${role} stopped with ${response.status}: ${response.error ?? 'Inspect its receipt'} (${file})`);
    invariant(response.result?.kind === 'structured', `Subagent ${role} did not return a structured result`);
    const value = validateResult(schema, response.result.value);
    if (wp && this.config.limits.maxCostUsdPerWp !== null) {
      invariant(wp.unknownUsage === 0, 'Child cost is unknown; configured cost gate cannot be verified');
      invariant(wp.costUsd <= this.config.limits.maxCostUsdPerWp, 'Child completed after crossing the configured cost gate. Results are saved, but execution is paused.');
    }
    return { value, artifact: file };
  }
  async preflight(signal) {
    invariant(this.state.workPackages.length === 0, 'Preflight is only available before campaign approval');
    invariant(!Object.keys(this.state.activeAttempts).length, 'Recover unresolved prior attempts first');
    const release = await acquireLock(this.store.lockFile, { campaign: this.config.id, action: 'preflight' });
    try {
      await this.store.assertFresh();
      await this.subagents.ping(); this.subagents.register(this.config.agents);
      const snapshot = await inputSnapshot(this.loaded, this.repo.root); await this.store.snapshotInputs(snapshot);
      const result = await this.agent('preflight', this.context(null, `Review proposed controller configuration:\n${JSON.stringify(this.config, null, 2)}\nFind clarifications now. Do not implement.`), this.repo.root, null, signal);
      this.state.preflight = { at: now(), digest: snapshot.digest, ...result };
      const r = result.value;
      const report = `# Preflight: ${this.config.id}\n\n${r.summary}\n\n## Questions\n${r.questions.length ? r.questions.map((q, i) => `${i + 1}. ${q}`).join('\n') : 'No questions reported.'}\n\n## Risks\n${r.risks.map(risk => `- ${risk}`).join('\n') || 'None reported.'}\n`;
      const file = await this.store.artifact('preflight.md', report);
      this.state.status = 'draft'; await this.store.save({ type: 'preflight', artifact: file });
      this.notify(`${report}\nRecord resolved answers in ${path.join(this.loaded.planDir, this.config.decisions)}, add actual verification commands to longtask.json, commit those files, then /longtask approve.`);
    } finally { await release(); }
  }
  async setPhase(wp, phase) {
    wp.phase = phase; await this.store.save({ type: 'phase', wp: wp.id, phase });
    this.notify(`${wp.id} · ${phase}`);
  }
  async repair(wp, reason, evidence, tree) {
    invariant(wp.repairs < this.config.limits.maxRepairsPerWp, `Repair allowance exhausted for ${wp.id}; inspect evidence before /longtask retry`);
    wp.repairs++;
    wp.repair = { reason, artifact: await this.store.artifact(`${wp.id}-repair-${wp.calls}-${wp.repairs}.json`, evidence), beforeTree: tree };
    wp.local = null; wp.review = null; wp.ci = null; wp.ciStartedAt = null;
    await this.setPhase(wp, 'fix');
  }
  async runCheck(spec, wp, index, signal) {
    const cwd = path.resolve(wp.worktree, spec.cwd ?? '.');
    invariant(within(wp.worktree, cwd), 'Check cwd escaped the worktree'); await noSymlinks(cwd);
    const label = `${wp.id}-${wp.phase}-${wp.calls}-${index}-${randomUUID().slice(0, 8)}`;
    this.notify(`${wp.id} · ${wp.phase} · ${spec.name}`);
    let result;
    try {
      result = await this.runner(spec.command, { cwd, signal, env: spec.env, timeoutMs: (spec.timeoutSeconds ?? 900) * 1000, allowFailure: true });
    } catch (e) {
      await this.store.artifact(`${label}.json`, { name: spec.name, error: errorText(e), command: spec.command }); throw e;
    }
    const artifact = await this.store.artifact(`${label}.json`, { name: spec.name, ...result });
    return { name: spec.name, code: result.code, timedOut: result.timedOut, durationMs: result.durationMs, artifact };
  }
  async prepare(wp, spec, signal) {
    const index = this.state.current;
    if (!wp.creating) {
      const previous = this.state.workPackages[index - 1];
      wp.branch = `${this.config.branchPrefix}/${spec.id.slice(2)}`;
      wp.target = previous?.branch ?? this.config.baseBranch;
      wp.baseSha = previous?.commit ?? this.state.approval.baseSha;
      wp.headSha = wp.baseSha;
      wp.worktree = path.join(this.loaded.worktreeRoot, `${this.config.id}-${spec.id.toLowerCase()}`);
      await this.repo.assertTarget(wp, this.config.remote, signal);
      invariant(!await this.repo.refExists(wp.branch), `Branch ${wp.branch} already exists and is not owned by this run`);
      invariant(!await this.repo.remoteSha(this.config.remote, wp.branch, signal), `Remote branch ${wp.branch} already exists`);
      invariant(!await exists(wp.worktree), `Worktree path already exists: ${wp.worktree}`);
      wp.creating = true; await this.store.save({ type: 'worktree-intent', wp: wp.id });
    }
    await this.repo.assertTarget(wp, this.config.remote, signal);
    await this.repo.createWorktree(wp, this.loaded.worktreeRoot, signal);
    wp.creating = false; wp.status = 'running'; wp.setupIndex = 0;
    await this.setPhase(wp, 'setup');
  }
  async step(wp, spec, signal) {
    const extra = `Worktree: ${wp.worktree}\nBranch: ${wp.branch}\nPinned base/target SHA: ${wp.baseSha}\nTarget branch: ${wp.target}\nDo not edit the approved plan or campaign inputs.`;
    switch (wp.phase) {
      case 'prepare': return this.prepare(wp, spec, signal);
      case 'setup': {
        while (wp.setupIndex < this.config.setup.length) {
          const receipt = await this.runCheck(this.config.setup[wp.setupIndex], wp, wp.setupIndex, signal);
          invariant(receipt.code === 0 && !receipt.timedOut, `Setup failed. Inspect ${receipt.artifact}; setup commands must be idempotent before retrying.`);
          await this.repo.assertIdentity(wp);
          // Save the completed index before another command can run.
          wp.setupIndex++; await this.store.save({ type: 'setup-complete', wp: wp.id, receipt });
        }
        return this.setPhase(wp, 'scout');
      }
      case 'scout': {
        const result = await this.agent('scout', this.context(spec, extra), wp.worktree, wp, signal);
        wp.scout = result.artifact; return this.setPhase(wp, 'implement');
      }
      case 'implement':
      case 'fix': {
        const fixing = wp.phase === 'fix';
        const assignment = fixing ? `Fix the justified issues described in ${wp.repair.artifact}. Reason: ${wp.repair.reason}. Diagnose whether failures are attributable to this WP; report blocked for infrastructure failures or unresolved owner decisions. Do not weaken checks.` : `Implement this WP. Read scouting evidence: ${wp.scout}`;
        const result = await this.agent('worker', this.context(spec, `${extra}\n${assignment}\nApproved checks:\n${JSON.stringify([...this.config.checks, ...(spec.checks ?? []), ...this.config.uiChecks])}`), wp.worktree, wp, signal);
        await this.repo.assertIdentity(wp); wp.worker = result.artifact;
        invariant(result.value.status === 'done' && result.value.blockers.length === 0, `Worker blocked: ${result.value.blockers.join('; ') || result.value.summary}`);
        if (fixing) {
          const after = await this.repo.snapshot(wp, this.gitConfig ?? this.config);
          wp.noProgress = after.tree === wp.repair.beforeTree ? wp.noProgress + 1 : 0;
          invariant(wp.noProgress < this.config.limits.maxNoProgressRepairs, 'Repeated repairs made no code progress; inspect the blocker instead of looping');
        }
        return this.setPhase(wp, 'verify');
      }
      case 'verify': {
        const before = await this.repo.snapshot(wp, this.gitConfig ?? this.config);
        const uiRequired = hasUi(this.config, spec, before.files);
        invariant(!uiRequired || this.config.uiChecks.length > 0, 'Client changes detected but uiChecks is empty. Browser acceptance commands must be configured before approval.');
        const checks = [...this.config.checks, ...(spec.checks ?? []), ...(uiRequired ? this.config.uiChecks : [])];
        invariant(checks.length, 'No verification checks configured');
        const receipts = [];
        for (let i = 0; i < checks.length; i++) {
          const receipt = await this.runCheck(checks[i], wp, i, signal); receipts.push(receipt);
          await this.repo.assertIdentity(wp);
          if (receipt.code !== 0 || receipt.timedOut) return this.repair(wp, 'Local acceptance checks failed', receipts, before.tree);
        }
        const after = await this.repo.snapshot(wp, this.gitConfig ?? this.config);
        invariant(after.tree === before.tree, 'Verification commands modified source files. Use check-only commands; setup/build outputs should be ignored. No review/CI gate was accepted.');
        wp.local = { at: now(), tree: after.tree, files: after.files, uiRequired, receipts };
        wp.diff = await this.store.artifact(`${wp.id}-${after.tree}.patch`, after.diff);
        return this.setPhase(wp, 'review');
      }
      case 'review': {
        const snapshot = await this.repo.snapshot(wp, this.gitConfig ?? this.config);
        invariant(snapshot.tree === wp.local?.tree, 'Source changed since local verification');
        const evidence = `Independently review the actual staged change. Patch: ${wp.diff}\nDo not read prior worker/scout reasoning.\nVerification receipts (read logs when relevant):\n${JSON.stringify(wp.local, null, 2)}\nReview the entire WP, actual diff and relevant current files. The candidate Git tree is ${snapshot.tree}.`;
        const roles = ['correctness', 'architecture', 'tests'];
        const results = await Promise.allSettled(roles.map(role => this.agent(role, this.context(spec, `${extra}\n${evidence}`), wp.worktree, wp, signal)));
        const failure = results.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
        const reviews = results.map(r => r.value);
        invariant((await this.repo.snapshot(wp, this.gitConfig ?? this.config)).tree === snapshot.tree, 'Files changed during read-only review');
        for (const r of reviews) invariant(r.value.verdict !== 'blocked', `Reviewer blocked: ${r.value.summary} (${r.artifact})`);
        for (const r of reviews) invariant(r.value.verdict !== 'changes_requested' || r.value.findings.some(f => f.severity === 'blocking'), 'Reviewer requested changes without a concrete blocking finding; inspect its receipt');
        const rejected = reviews.some(r => r.value.verdict !== 'pass' || r.value.findings.some(f => f.severity === 'blocking'));
        if (rejected) return this.repair(wp, 'Independent review found blocking issues', reviews, snapshot.tree);
        wp.review = { at: now(), tree: snapshot.tree, receipts: reviews.map(r => r.artifact) };
        return this.setPhase(wp, 'commit');
      }
      case 'commit': {
        // A crash may have occurred after git commit but before the phase write.
        // Reuse a controller-owned, already-verified commit instead of committing twice.
        const recovered = await this.repo.reconcileCommit(wp);
        const alreadyCommitted = wp.commit && wp.headSha === wp.commit && (await this.repo.text(['rev-parse', `${wp.commit}^{tree}`], wp.worktree)) === wp.review?.tree;
        if (!recovered && !alreadyCommitted) {
          invariant(wp.local?.tree && wp.local.tree === wp.review?.tree, 'Local and review gates do not bind the same Git tree');
          wp.commitIntent = { parent: wp.headSha, tree: wp.review.tree };
          await this.store.save({ type: 'commit-intent', wp: wp.id });
          const sha = await this.repo.commit(wp, wp.review.tree, `${spec.id}: ${spec.title ?? this.config.id}${wp.repairs ? ' (verified fixes)' : ''}`, signal);
          wp.commit = sha; wp.headSha = sha; wp.commitIntent = null;
        }
        return this.setPhase(wp, 'publish');
      }
      case 'publish': {
        await this.repo.push(wp, this.config.remote, signal); wp.pushedSha = wp.commit;
        await this.store.save({ type: 'pushed', wp: wp.id, sha: wp.commit });
        const previous = this.state.workPackages[this.state.current - 1];
        const description = `Implements ${spec.id} from ${path.relative(this.repo.root, this.loaded.planDir)}.\n\n${previous?.mr ? `Stacked on !${previous.mr.iid}. Merge in plan order after the campaign has finished.` : `First MR in the stack; target: ${this.config.baseBranch}.`}\n\nLocal acceptance and independent correctness, architecture and test reviews passed for the submitted tree. Remote CI is checked separately by the controller.\n\nDo not delete intermediate branches or squash/rebase this stack while the campaign is running. The controller does not merge MRs.\n\n<!-- pi-longtask:${this.config.id}:${spec.id} -->`;
        wp.mr = await this.gitlab.ensureMr(wp, `${spec.id}: ${spec.title ?? this.config.id}`, description, signal);
        wp.ciStartedAt = now(); wp.ci = null; return this.setPhase(wp, 'ci');
      }
      case 'ci': {
        wp.ciStartedAt ??= now();
        invariant(Date.now() - Date.parse(wp.ciStartedAt) < this.config.ci.timeoutMinutes * 60000, 'CI deadline reached. Inspect pipeline availability/status; /longtask retry renews the wait allowance.');
        const result = await this.gitlab.check(wp, this.config.ci, signal);
        wp.lastCi = { at: now(), state: result.state, reason: result.reason, pipeline: result.pipeline };
        await this.store.save({ type: 'ci', wp: wp.id, state: result.state, pipeline: result.pipeline?.id });
        if (result.state === 'wait') { this.notify(`${wp.id} · ${result.reason}`, { transient: true }); return sleep(this.config.ci.pollSeconds * 1000, signal); }
        invariant(result.state !== 'blocked', result.reason);
        if (result.state === 'repair') return this.repair(wp, 'CI failed on the pushed commit', result, wp.review.tree);
        invariant(result.state === 'success', 'Unknown CI decision');
        wp.ci = { at: now(), sourceSha: wp.commit, pipelineId: result.pipeline.id, pipelineSha: result.pipeline.sha, status: result.pipeline.status, url: result.pipeline.web_url, jobs: result.jobs };
        return this.setPhase(wp, 'checkpoint');
      }
      case 'checkpoint': {
        await this.repo.assertClean(wp.worktree);
        invariant(await this.repo.remoteSha(this.config.remote, wp.branch, signal) === wp.commit, 'Remote source changed after CI');
        const tree = await this.repo.text(['rev-parse', `${wp.commit}^{tree}`], wp.worktree);
        invariant(tree === wp.local?.tree && tree === wp.review?.tree && wp.ci?.sourceSha === wp.commit && wp.ci?.pipelineSha === wp.commit && wp.ci?.status === 'success', 'Completion evidence does not bind the same commit/tree');
        const fresh = await this.gitlab.check(wp, this.config.ci, signal);
        invariant(fresh.state === 'success', 'CI or MR state changed before checkpoint; inspect it');
        wp.checkpoint = await this.store.artifact(`${wp.id}-checkpoint.json`, { id: wp.id, branch: wp.branch, target: wp.target, baseSha: wp.baseSha, commit: wp.commit, mr: wp.mr, local: wp.local, review: wp.review, ci: wp.ci, at: now() });
        wp.status = 'verified'; return this.setPhase(wp, 'cleanup');
      }
      case 'cleanup': {
        invariant(await this.repo.remoteSha(this.config.remote, wp.branch, signal) === wp.commit, 'Remote source changed before cleanup');
        invariant(await this.repo.sha(`refs/heads/${wp.branch}`) === wp.commit, 'Local source changed before cleanup');
        if (this.config.cleanup) await this.repo.cleanup(wp, this.loaded.worktreeRoot, signal);
        else { await this.repo.assertIdentity(wp); await this.repo.assertClean(wp.worktree); }
        wp.status = 'complete'; wp.phase = 'done'; wp.completedAt = now(); this.state.current++;
        await this.store.save({ type: 'wp-complete', wp: wp.id, mr: wp.mr, commit: wp.commit });
        await this.onCheckpoint(wp, this.config.compactBetweenWps);
        return;
      }
      default: throw new Error(`Unknown phase ${wp.phase}; state migration is required`);
    }
  }
  async assertCompletedStack(signal) {
    for (const wp of this.state.workPackages.slice(0, this.state.current)) {
      invariant(wp.status === 'complete', 'Completed stack prefix contains an incomplete WP');
      invariant(await this.repo.sha(`refs/heads/${wp.branch}`) === wp.commit, `Completed local branch ${wp.branch} moved`);
      invariant(await this.repo.remoteSha(this.config.remote, wp.branch, signal) === wp.commit, `Completed remote branch ${wp.branch} moved or was deleted`);
      invariant((await this.gitlab.check(wp, this.config.ci, signal)).state === 'success', `Completed MR for ${wp.id} is no longer an open, successful gate`);
    }
  }
  async run({ signal, one = false } = {}) {
    invariant(!Object.keys(this.state.activeAttempts).length, 'An earlier child lacks a terminal receipt. Run /longtask recover only after checking it has stopped.');
    invariant(this.state.status !== 'completed', 'Campaign is already complete');
    invariant(this.state.status !== 'aborted', 'Campaign was aborted. /longtask retry is required before explicit restart.');
    const release = await acquireLock(this.store.lockFile, { campaign: this.config.id, action: 'run' });
    try {
      await this.store.assertFresh();
      await this.assertApproval();
      invariant(await this.repo.validateBase(this.config, signal) === this.state.approval.baseSha, 'The original base branch moved since approval');
      await this.connect(signal); await this.assertCompletedStack(signal); this.state.status = 'running'; this.state.error = null;
      await this.store.save({ type: 'run-start' }); const startingIndex = this.state.current;
      while (this.state.current < this.state.workPackages.length) {
        aborted(signal);
        if (this.pauseRequested || (one && this.state.current > startingIndex)) { this.state.status = 'paused'; break; }
        await this.assertApproval(); await this.repo.assertClean();
        const wp = this.state.workPackages[this.state.current]; const spec = this.config.workPackages[this.state.current];
        if (wp.phase === 'prepare') await this.assertCompletedStack(signal);
        if (wp.phase !== 'prepare') {
          await this.repo.assertTarget(wp, this.config.remote, signal);
          if (wp.phase === 'commit' && wp.commitIntent) await this.repo.reconcileCommit(wp);
          if (wp.phase !== 'cleanup') await this.repo.assertIdentity(wp);
        }
        await this.step(wp, spec, signal);
      }
      if (this.state.current >= this.state.workPackages.length) this.state.status = 'completed';
      await this.store.save({ type: 'run-end', status: this.state.status });
      this.notify(`${this.config.id}: ${this.state.status}. ${this.state.current}/${this.state.workPackages.length} WPs complete.`);
    } catch (e) {
      this.state.status = signal?.aborted ? 'paused' : 'blocked'; this.state.error = errorText(e);
      await this.store.save({ type: this.state.status, error: this.state.error });
      this.notify(`${this.config.id}: ${this.state.status}\n${this.state.error}`);
      throw e;
    } finally { await release(); }
  }
  async retry() {
    invariant(!Object.keys(this.state.activeAttempts).length, 'Unresolved child attempts must be recovered, not retried');
    const wp = this.state.workPackages[this.state.current]; invariant(wp, 'No incomplete WP to retry');
    invariant(this.state.status !== 'running', 'Pause or stop the current run first');
    wp.allowanceCalls = 0; wp.repairs = 0; wp.noProgress = 0; wp.ciStartedAt = null;
    this.state.status = 'paused'; this.state.error = null;
    await this.store.save({ type: 'manual-retry-allowance', wp: wp.id });
  }
}
