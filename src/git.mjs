import fs from 'node:fs/promises';
import path from 'node:path';
import { command, exists, invariant, matchesAny, noSymlinks, within } from './util.mjs';

export class Repo {
  constructor(root, commonDir, runner = command) { this.root = root; this.commonDir = commonDir; this.runner = runner; }
  static async open(cwd, runner = command) {
    const root = (await runner(['git', 'rev-parse', '--show-toplevel'], { cwd })).stdout.trim();
    const common = (await runner(['git', 'rev-parse', '--git-common-dir'], { cwd: root })).stdout.trim();
    return new Repo(root, path.resolve(root, common), runner);
  }
  async git(args, cwd = this.root, options = {}) { return this.runner(['git', ...args], { cwd, ...options }); }
  async text(args, cwd = this.root, options = {}) { return (await this.git(args, cwd, options)).stdout.trim(); }
  async sha(ref, cwd = this.root) { return this.text(['rev-parse', '--verify', `${ref}^{commit}`], cwd); }
  async refExists(branch) { return (await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], this.root, { allowFailure: true })).code === 0; }
  async remoteSha(remote, branch, signal) {
    const out = await this.text(['ls-remote', '--heads', remote, `refs/heads/${branch}`], this.root, { signal });
    return out ? out.split(/\s+/)[0] : null;
  }
  async assertClean(cwd = this.root) {
    const dirty = await this.text(['status', '--porcelain=v1', '--untracked-files=all'], cwd);
    invariant(!dirty, `Working tree is not clean: ${cwd}\n${dirty.slice(0, 2500)}`);
  }
  async validateBase(config, signal) {
    await this.git(['check-ref-format', '--branch', config.baseBranch]);
    await this.git(['check-ref-format', '--branch', `${config.branchPrefix}/00`]);
    invariant((await this.text(['symbolic-ref', '--short', 'HEAD'])) === config.baseBranch, `Start Pi in the checkout of ${config.baseBranch}`);
    await this.assertClean();
    const sha = await this.sha(`refs/heads/${config.baseBranch}`);
    invariant(await this.remoteSha(config.remote, config.baseBranch, signal) === sha, `Push ${config.baseBranch} to ${config.remote}; the local and remote base commits must match`);
    invariant(await this.text(['config', 'user.name']), 'git user.name is required');
    invariant(await this.text(['config', 'user.email']), 'git user.email is required');
    const stages = await this.text(['ls-files', '--stage']);
    invariant(!stages.split('\n').some(l => l.startsWith('160000 ')), 'Version 0.1 does not manage repositories with Git submodules');
    return sha;
  }
  async assertTarget(wp, remote, signal) {
    invariant(await this.sha(`refs/heads/${wp.target}`) === wp.baseSha, `Local target ${wp.target} moved; automatic rebasing is disabled`);
    invariant(await this.remoteSha(remote, wp.target, signal) === wp.baseSha, `Remote target ${wp.target} moved or was deleted. Do not merge or rebase the stack while it is running.`);
  }
  async listWorktrees() {
    const out = await this.text(['worktree', 'list', '--porcelain']);
    return out.split('\n\n').filter(Boolean).map(block => Object.fromEntries(block.split('\n').map(line => {
      const pos = line.indexOf(' '); return pos < 0 ? [line, true] : [line.slice(0, pos), line.slice(pos + 1)];
    })));
  }
  async createWorktree(wp, worktreeRoot, signal) {
    await noSymlinks(worktreeRoot); await fs.mkdir(worktreeRoot, { recursive: true });
    invariant(within(worktreeRoot, wp.worktree) && path.dirname(wp.worktree) === worktreeRoot, 'Worktree must be an immediate child of worktreeRoot');
    await noSymlinks(wp.worktree);
    const listed = (await this.listWorktrees()).find(w => path.resolve(w.worktree) === wp.worktree);
    if (listed) {
      invariant(listed.branch === `refs/heads/${wp.branch}`, 'Worktree is attached to an unexpected branch');
      invariant(await exists(wp.worktree), 'Worktree registration exists but its directory is missing. Inspect it before recovery.');
    } else {
      invariant(!await exists(wp.worktree), `Unowned worktree path already exists: ${wp.worktree}`);
      if (await this.refExists(wp.branch)) {
        invariant(wp.creating || wp.commit, `Unowned branch exists: ${wp.branch}`);
        await this.git(['worktree', 'add', wp.worktree, wp.branch], this.root, { signal });
      } else {
        invariant(wp.creating && !wp.commit, 'Previously owned branch is missing; refusing to recreate implementation history');
        await this.git(['worktree', 'add', '-b', wp.branch, wp.worktree, wp.baseSha], this.root, { signal });
      }
    }
    const common = await this.text(['rev-parse', '--git-common-dir'], wp.worktree);
    invariant(path.resolve(wp.worktree, common) === this.commonDir, 'Worktree belongs to another Git repository');
    await this.assertIdentity(wp);
  }
  async assertIdentity(wp) {
    invariant(await exists(wp.worktree), `Worktree is missing: ${wp.worktree}`);
    await noSymlinks(wp.worktree);
    invariant(await this.text(['symbolic-ref', '--short', 'HEAD'], wp.worktree) === wp.branch, 'Worker changed branches; inspect the worktree');
    const head = await this.sha('HEAD', wp.worktree);
    invariant(head === (wp.headSha ?? wp.baseSha), `HEAD moved outside the controller (${head}); inspect unauthorized commits before recovery`);
    const ancestor = await this.git(['merge-base', '--is-ancestor', wp.baseSha, head], wp.worktree, { allowFailure: true });
    invariant(ancestor.code === 0, 'WP is not based on the pinned target commit');
  }
  async changedFiles(wp) {
    const tracked = (await this.git(['diff', '--name-only', '-z', wp.baseSha, '--'], wp.worktree)).stdout.split('\0').filter(Boolean);
    const untracked = (await this.git(['ls-files', '--others', '--exclude-standard', '-z'], wp.worktree)).stdout.split('\0').filter(Boolean);
    return [...new Set([...tracked, ...untracked])];
  }
  async snapshot(wp, config) {
    await this.assertIdentity(wp);
    const files = await this.changedFiles(wp);
    for (const f of files) invariant(!config.immutablePaths?.includes(f), `Approved campaign input was changed inside the worktree: ${f}`);
    for (const f of files) invariant(!matchesAny(config.denyPaths, f) || matchesAny(config.allowSensitivePaths, f), `Sensitive file blocked before staging: ${f}`);
    await this.git(['diff', '--check'], wp.worktree);
    await this.git(['add', '-A', '--', '.'], wp.worktree);
    await this.git(['diff', '--cached', '--check', wp.baseSha, '--'], wp.worktree);
    const tree = await this.text(['write-tree'], wp.worktree);
    const baseTree = await this.text(['rev-parse', `${wp.baseSha}^{tree}`], wp.worktree);
    invariant(tree !== baseTree, 'WP contains no changes relative to its target; it cannot be silently marked complete');
    const diff = (await this.git(['diff', '--cached', '--binary', '--no-ext-diff', wp.baseSha, '--'], wp.worktree)).stdout;
    return { tree, files, diff };
  }
  async commit(wp, tree, message, signal) {
    const current = await this.snapshot(wp, { denyPaths: [], allowSensitivePaths: [] });
    invariant(current.tree === tree, 'Files changed after verification/review; refusing to commit');
    await this.git(['commit', '-m', message], wp.worktree, { signal, timeoutMs: 300000 });
    const sha = await this.sha('HEAD', wp.worktree);
    invariant(await this.text(['rev-parse', `${sha}^{tree}`], wp.worktree) === tree, 'Commit hook changed the verified tree; inspect the commit before proceeding');
    await this.assertClean(wp.worktree);
    return sha;
  }
  async reconcileCommit(wp) {
    if (!wp.commitIntent) return false;
    const head = await this.sha('HEAD', wp.worktree);
    if (head === wp.commitIntent.parent) return false;
    const parent = await this.text(['rev-parse', `${head}^`], wp.worktree);
    const tree = await this.text(['rev-parse', `${head}^{tree}`], wp.worktree);
    invariant(parent === wp.commitIntent.parent && tree === wp.commitIntent.tree, 'Commit recovery does not match the recorded intent; inspect manually');
    await this.assertClean(wp.worktree); wp.headSha = head; wp.commit = head; wp.commitIntent = null;
    return true;
  }
  async push(wp, remote, signal) {
    await this.assertIdentity(wp); await this.assertClean(wp.worktree);
    invariant(wp.headSha === wp.commit, 'No verified commit to push');
    const existing = await this.remoteSha(remote, wp.branch, signal);
    invariant(!existing || existing === wp.commit || existing === wp.pushedSha, 'Remote source branch moved outside the controller');
    await this.git(['push', '--set-upstream', remote, `${wp.commit}:refs/heads/${wp.branch}`], wp.worktree, { signal, timeoutMs: 120000 });
    invariant(await this.remoteSha(remote, wp.branch, signal) === wp.commit, 'Push could not be verified');
  }
  async cleanup(wp, worktreeRoot, signal) {
    invariant(path.dirname(wp.worktree) === worktreeRoot, 'Refusing cleanup outside configured worktree root');
    if (!await exists(wp.worktree)) {
      invariant(!(await this.listWorktrees()).some(w => path.resolve(w.worktree) === wp.worktree), 'Missing worktree still registered; inspect manually');
      return;
    }
    await this.assertIdentity(wp); await this.assertClean(wp.worktree);
    // Never force: unexpected files/submodules/locks make Git stop instead of losing data.
    await this.git(['worktree', 'remove', '--', wp.worktree], this.root, { signal, timeoutMs: 120000 });
  }
}
