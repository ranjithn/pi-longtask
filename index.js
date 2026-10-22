import path from 'node:path';
import { Repo } from './src/git.mjs';
import { loadConfig, initializeConfig } from './src/config.mjs';
import { Store } from './src/store.mjs';
import { Subagents } from './src/delegation.mjs';
import { Engine } from './src/engine.mjs';
import { atomicJson, errorText, exists, invariant, now, readJson, removeDeadLock, splitArgs, within, acquireLock } from './src/util.mjs';

const HELP = `pi-longtask 0.1.0
/longtask init <plan-dir> [--base main] [--from WP00 --to WP01]
    [--branch-prefix longtask/<campaign-id>] [--worktree-root ../.pi-longtask-worktrees]
/longtask use <plan-dir>       Select an existing longtask.json
/longtask doctor              Check Pi/subagents/Git/glab and show available tools
/longtask dry-run             Show the branch stack and configured commands; run nothing
/longtask preflight           Read-only plan audit; answer questions in decisions.md
/longtask approve             Freeze inputs and authorize configured side effects
/longtask run [--one]         Execute all remaining WPs (or just the next one)
/longtask status              Show checkpoint, phase, attempts, cost and artifact location
/longtask pause               Finish the current phase, then pause
/longtask stop                Cancel active children/commands; keep branches/worktrees
/longtask resume [--one]      Resume from persisted state, without resetting allowances
/longtask retry               Grant a fresh bounded repair/call allowance; then resume
/longtask recover             Confirm old workers are stopped; resolve stale lock/attempts
/longtask abort               Stop and mark aborted; preserve worktrees, branches and MRs
No automatic merges, forced pushes, rebases, branch deletion, or silent gate skipping.`;

/** Uses only the stable command/event/UI subset of Pi's ExtensionAPI. No SDK copy is bundled. */
export default function longtask(pi) {
  let bridge = new Subagents(pi);
  let active = null;
  let currentContext;
  let lifecycle = 0;
  function message(ctx, content, transient = false) {
    if (transient) { ctx.ui.setStatus('longtask', content); return; }
    ctx.ui.setStatus('longtask', content.split('\n')[0]);
    pi.sendMessage({ customType: 'longtask', content, display: true }, { triggerTurn: false });
  }
  async function sessionRoot(ctx) {
    invariant(!ctx.isProjectTrusted || ctx.isProjectTrusted(), 'Trust this project before running longtask');
    return Repo.open(ctx.cwd);
  }
  async function selected(ctx) {
    const repo = await sessionRoot(ctx);
    const pointer = path.join(repo.commonDir, 'pi-longtask', 'selected.json');
    invariant(await exists(pointer), 'No campaign selected. Run /longtask init <plan-dir> or /longtask use <plan-dir>.');
    const { configPath } = await readJson(pointer);
    const loaded = await loadConfig(configPath, repo.root);
    const store = new Store(repo, loaded.config.id); await store.load(loaded.configPath);
    const engine = new Engine({ repo, loaded, store, subagents: bridge,
      notify: (text, opts) => message(ctx, text, opts?.transient),
      onCheckpoint: async (wp, compact) => {
        pi.appendEntry('longtask-checkpoint', { campaign: loaded.config.id, wp: wp.id, branch: wp.branch, mr: wp.mr, commit: wp.commit, stateFile: store.stateFile });
        message(ctx, `${wp.id} complete · ${wp.mr.url}\nCommit ${wp.commit}\nCheckpoint ${wp.checkpoint}`);
        if (compact) {
          invariant(ctx.isIdle(), 'Parent model is busy; checkpoint saved. Compact manually before resuming.');
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Compaction did not finish within 3 minutes; checkpoint is safe.')), 180000);
            ctx.compact({ customInstructions: `Longtask state is authoritative at ${store.stateFile}. Keep only the campaign ID, state path, approved plan path and last completed WP. Never infer progress from this summary.`, onComplete: () => { clearTimeout(timer); resolve(); }, onError: e => { clearTimeout(timer); reject(e); } });
          });
        }
      },
    });
    return { repo, loaded, store, engine, pointer };
  }
  function start(ctx, bundle, action, options = {}) {
    invariant(!active, 'A longtask operation is already active. Pause or stop it first.');
    invariant(ctx.isIdle(), 'Finish or abort the parent model turn before starting a campaign');
    const controller = new AbortController(); const generation = lifecycle;
    const job = { ...bundle, controller, action, promise: null, abortCampaign: false, generation };
    active = job;
    // Return command control so /longtask status/stop remain available. The Pi process
    // owns this task; it is not a daemon and never survives a process shutdown.
    job.promise = (async () => {
      try {
        if (action === 'preflight') await bundle.engine.preflight(controller.signal);
        else await bundle.engine.run({ signal: controller.signal, one: options.one });
      } catch (e) {
        if (action === 'preflight') {
          bundle.store.state.status = controller.signal.aborted ? 'paused' : 'blocked';
          bundle.store.state.error = errorText(e);
          try { await bundle.store.save({ type: 'preflight-stopped', error: errorText(e) }); } catch {}
        }
        if (generation === lifecycle) message(ctx, `Longtask stopped: ${errorText(e)}`);
      } finally {
        if (job.abortCampaign) { bundle.store.state.status = 'aborted'; await bundle.store.save({ type: 'aborted' }); }
        if (active === job) active = null;
      }
    })();
    // Final persistence errors must not become unhandled promise rejections.
    job.promise.catch(e => { if (generation === lifecycle) ctx.ui.notify(`Longtask persistence error: ${errorText(e)}`, 'error'); });
  }
  async function lockedMutation(bundle, action) {
    const release = await acquireLock(bundle.store.lockFile, { campaign: bundle.loaded.config.id, action: 'manual-control' });
    try { await bundle.store.assertFresh(); return await action(); } finally { await release(); }
  }
  pi.registerCommand('longtask', {
    description: 'Run approved work-package plans with durable checkpoints and stacked GitLab MRs',
    handler: async (input, ctx) => {
      currentContext = ctx;
      try {
        const [verb = 'help', ...args] = splitArgs(input);
        if (verb === 'help') { message(ctx, HELP); return; }
        if (['pause', 'stop', 'abort'].includes(verb) && active) {
          if (verb === 'pause') { active.engine.pauseRequested = true; message(ctx, 'Pause requested; the current phase will finish. Use /longtask stop for immediate cancellation.'); }
          else { active.abortCampaign = verb === 'abort'; active.controller.abort(new Error(verb === 'abort' ? 'Campaign aborted by owner' : 'Stopped by owner')); bridge.cancelAll(); message(ctx, 'Cancellation requested. Worktrees and branches are being retained; status will change after child acknowledgements.'); }
          return;
        }
        if (active && !['status', 'doctor'].includes(verb)) throw new Error('A longtask operation is active. Use status, pause, stop or abort before other commands.');
        if (verb === 'init' || verb === 'use') {
          const repo = await sessionRoot(ctx); const plan = args.shift(); invariant(plan, `Usage: /longtask ${verb} <plan-dir>`);
          let file;
          if (verb === 'init') {
            const opts = {};
            const flags = { '--base': 'base', '--from': 'from', '--to': 'to', '--branch-prefix': 'branchPrefix', '--worktree-root': 'worktreeRoot' };
            while (args.length) { const flag = args.shift(); invariant(flags[flag] && args.length, `Unknown/missing flag: ${flag}`); opts[flags[flag]] = args.shift(); }
            for (const field of ['from', 'to']) if (opts[field]) invariant(/^WP\d{2,4}$/.test(opts[field]), `${field} must be WPnn`);
            file = await initializeConfig(repo.root, plan, opts);
          } else { invariant(!args.length, 'Unexpected arguments'); file = path.resolve(repo.root, plan, 'longtask.json'); }
          const loaded = await loadConfig(file, repo.root);
          const store = new Store(repo, loaded.config.id); await store.load(file);
          await atomicJson(path.join(repo.commonDir, 'pi-longtask', 'selected.json'), { configPath: file });
          message(ctx, `Selected ${loaded.config.id}\nConfig: ${file}\nState: ${store.stateFile}\n\nAdd your actual setup/check commands and any browser tests to longtask.json. Run /longtask preflight, resolve its questions, commit the configuration/decisions, then /longtask approve. No implementation has started.`);
          return;
        }
        if (verb === 'doctor') {
          const lines = [`Node ${process.version}`, `Pi project cwd: ${ctx.cwd}`];
          try { const reply = await bridge.ping(); lines.push(`pi-subagents RPC: responding\n${JSON.stringify(reply).slice(0, 2500)}`); }
          catch (e) { lines.push(`pi-subagents: ${errorText(e)}`); }
          try {
            const repo = await sessionRoot(ctx); lines.push(`Git root: ${repo.root}`);
            const { command } = await import('./src/util.mjs');
            lines.push((await command(['git', '--version'], { cwd: repo.root })).stdout.trim());
            try { lines.push((await command(['glab', '--version'], { cwd: repo.root })).stdout.trim()); } catch (e) { lines.push(`glab: ${errorText(e)}`); }
          } catch (e) { lines.push(`Git: ${errorText(e)}`); }
          if (pi.getAllTools) lines.push(`Parent tool names (child tools must be explicitly configured):\n${pi.getAllTools().map(t => t.name).join(', ')}`);
          lines.push('No dependency installation, agent call, test, commit or network write was performed. A responding RPC alone does not prove registration/delegation compatibility; preflight exercises that contract.');
          message(ctx, lines.join('\n')); return;
        }
        const bundle = active ?? await selected(ctx);
        const { repo, loaded, store, engine } = bundle;
        if (verb === 'status') {
          const s = store.state; const w = s.workPackages[s.current];
          const rows = s.workPackages.map(p => `${p.id}: ${p.status} · ${p.phase}${p.mr ? ` · !${p.mr.iid}` : ''} · calls ${p.calls} · recorded cost $${p.costUsd.toFixed(4)}${p.unknownUsage ? ` + ${p.unknownUsage} unknown-usage attempts` : ''}`);
          message(ctx, `${loaded.config.id}: ${s.status}${active ? ' (controller active)' : ''}\n${w ? `Current: ${w.id} / ${w.phase}` : 'No active WP'}\n${rows.join('\n')}\nUnresolved attempts: ${Object.keys(s.activeAttempts).length}\n${s.error ? `Last error: ${s.error}\n` : ''}State: ${store.stateFile}\nArtifacts: ${store.dir}/artifacts`); return;
        }
        if (verb === 'dry-run') {
          let target = loaded.config.baseBranch;
          const lines = loaded.config.workPackages.map(w => { const branch = `${loaded.config.branchPrefix}/${w.id.slice(2)}`; const line = `${w.id}: ${branch} → ${target}\n  Worktree: ${path.join(loaded.worktreeRoot, `${loaded.config.id}-${w.id.toLowerCase()}`)}\n  Spec: ${w.file}`; target = branch; return line; });
          message(ctx, `Proposed stack (no agents, setup/test commands or remote writes executed):\n${lines.join('\n')}\n\nSetup:\n${JSON.stringify(loaded.config.setup, null, 2)}\nChecks:\n${JSON.stringify(loaded.config.checks, null, 2)}\nBrowser checks:\n${JSON.stringify(loaded.config.uiChecks, null, 2)}\nLimits:\n${JSON.stringify(loaded.config.limits, null, 2)}`); return;
        }
        if (verb === 'preflight') { invariant(!args.length, 'Unexpected preflight arguments'); start(ctx, bundle, 'preflight'); return; }
        if (verb === 'approve') {
          invariant(!args.length, 'Approval is interactive; no --yes bypass');
          invariant(ctx.hasUI, 'Use an interactive Pi session to approve the campaign');
          await engine.approve(text => ctx.ui.confirm('Approve longtask campaign', text)); return;
        }
        if (verb === 'run' || verb === 'resume') {
          invariant(args.every(a => a === '--one') && args.length <= 1, `Usage: /longtask ${verb} [--one]`);
          start(ctx, bundle, 'run', { one: args.includes('--one') }); return;
        }
        if (verb === 'retry') {
          invariant(ctx.hasUI, 'Retry requires an interactive owner confirmation');
          if (await ctx.ui.confirm('Grant another bounded allowance?', 'This renews the current WP call/repair and CI-wait allowances. It does not erase total usage, waive verification gates, change approved inputs, or resume an uncertain child.')) {
            await lockedMutation(bundle, () => engine.retry()); message(ctx, 'Retry allowance recorded. /longtask resume continues the checkpoint.');
          }
          return;
        }
        if (verb === 'recover') {
          invariant(ctx.hasUI, 'Recovery requires interactive confirmation');
          const attempts = Object.values(store.state.activeAttempts);
          if (await ctx.ui.confirm('Confirm previous execution has stopped', `Inspect any earlier Pi session/child runs before continuing.\n\nUnresolved attempts:\n${JSON.stringify(attempts, null, 2)}\n\nAre all prior workers AND test/setup subprocesses for this campaign stopped? This does not kill them or prove that they stopped. It only permits checkpoint reconciliation. No code is discarded.`)) {
            await removeDeadLock(store.lockFile);
            await lockedMutation(bundle, async () => {
              store.state.abandonedAttempts ??= []; store.state.abandonedAttempts.push(...attempts.map(a => ({ ...a, acknowledgedStoppedAt: now() })));
              for (const a of attempts) { const wp = store.state.workPackages.find(w => w.id === a.wp); if (wp) wp.unknownUsage++; }
              store.state.activeAttempts = {}; store.state.status = 'paused'; store.state.error = null;
              await store.save({ type: 'owner-recovery', count: attempts.length });
            });
            message(ctx, 'Recovery acknowledgement recorded. Inspect the worktree, then /longtask resume. No branch, commit, or MR was deleted.');
          }
          return;
        }
        if (['pause', 'stop'].includes(verb)) { message(ctx, 'No controller is active in this Pi session. Saved state has not been changed.'); return; }
        if (verb === 'abort') { await lockedMutation(bundle, async () => { store.state.status = 'aborted'; await store.save({ type: 'aborted' }); }); message(ctx, 'Campaign marked aborted. Existing worktrees, branches and MRs were preserved.'); return; }
        throw new Error(`Unknown command: ${verb}\n${HELP}`);
      } catch (e) { ctx.ui.notify(errorText(e), 'error'); }
    },
  });
  pi.on('session_start', (_event, ctx) => { currentContext = ctx; });
  // Session-bound delegation must not silently continue into a different session.
  pi.on('session_before_switch', () => active ? { cancel: true } : undefined);
  pi.on('session_before_fork', () => active ? { cancel: true } : undefined);
  pi.on('session_before_tree', () => active ? { cancel: true } : undefined);
  pi.on('session_shutdown', async () => {
    const job = active;
    if (job) {
      job.controller.abort(new Error('Pi session shutdown')); bridge.cancelAll();
      // Public delegation cancellation includes a bounded acknowledgement timeout.
      await job.promise;
    }
    bridge.disposeRegistrations(); lifecycle++;
    currentContext?.ui.setStatus('longtask', undefined); currentContext = undefined;
  });
}
