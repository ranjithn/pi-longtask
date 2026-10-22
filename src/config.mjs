import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, exists, hash, invariant, matchesAny, noSymlinks, relativePath, within } from './util.mjs';

export const DEFAULTS = {
  version: 1, remote: 'origin', decisions: 'decisions.md', setup: [], checks: [], uiChecks: [],
  uiPaths: ['**/*.tsx', '**/*.jsx', '**/*.css', '**/*.html', '**/*.vue', '**/*.svelte', '**/frontend/**', '**/client/**'],
  denyPaths: ['.env', '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa', '**/id_ed25519'],
  allowSensitivePaths: [], cleanup: true, compactBetweenWps: false,
  infrastructure: 'Medplum and MedGemma are already running. Do not restart or reconfigure them. PostgreSQL runs in Docker for Medplum. Tests must use a separate explicitly configured test database/schema; never reset the Medplum database.',
  agents: {
    workerTools: ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'],
    reviewerTools: ['read', 'grep', 'find', 'ls'], workerExtensions: [],
    models: {}, thinking: 'high',
  },
  limits: { maxAgentCallsPerWp: 24, maxRepairsPerWp: 4, maxNoProgressRepairs: 2, agentTimeoutMinutes: 30, maxToolCallsPerAgent: 120, maxCostUsdPerWp: null },
  ci: { timeoutMinutes: 30, pollSeconds: 20, requiredJobs: [] },
};
function strings(value, label) { invariant(Array.isArray(value) && value.every(s => typeof s === 'string' && s && !s.includes('\0')), `${label} must be a string array`); }
function commands(value, label) {
  invariant(Array.isArray(value), `${label} must be an array`);
  for (const c of value) {
    invariant(c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim(), `${label}: every command needs a name`);
    strings(c.command, `${label}.${c.name}.command`); invariant(c.command.length, `${label}: command cannot be empty`);
    if (c.cwd) relativePath(c.cwd, `${label}.${c.name}.cwd`);
    invariant(c.timeoutSeconds === undefined || (Number.isInteger(c.timeoutSeconds) && c.timeoutSeconds >= 1 && c.timeoutSeconds <= 86400), `${label}: timeoutSeconds must be 1..86400`);
    invariant(!c.env || (typeof c.env === 'object' && !Array.isArray(c.env) && Object.entries(c.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && !v.includes('\0'))), `${label}: invalid env`);
  }
}
export function validateConfig(raw) {
  invariant(raw?.version === 1, 'Expected longtask config version: 1');
  const known = new Set([...Object.keys(DEFAULTS), 'id', 'baseBranch', 'branchPrefix', 'worktreeRoot', 'workPackages']);
  invariant(Object.keys(raw).every(k => known.has(k)), `Unknown config fields: ${Object.keys(raw).filter(k => !known.has(k)).join(', ')}`);
  const c = { ...structuredClone(DEFAULTS), ...raw, agents: { ...DEFAULTS.agents, ...raw.agents }, limits: { ...DEFAULTS.limits, ...raw.limits }, ci: { ...DEFAULTS.ci, ...raw.ci } };
  invariant(typeof c.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(c.id), 'id must be a safe name (1..80 characters)');
  for (const k of ['baseBranch', 'branchPrefix', 'remote']) invariant(typeof c[k] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(c[k]) && !c[k].includes('..'), `Unsafe ${k}`);
  invariant(typeof c.worktreeRoot === 'string' && c.worktreeRoot.length && !c.worktreeRoot.includes('\0'), 'worktreeRoot is required');
  relativePath(c.decisions, 'decisions');
  for (const k of ['setup', 'checks', 'uiChecks']) commands(c[k], k);
  for (const k of ['uiPaths', 'denyPaths', 'allowSensitivePaths']) strings(c[k], k);
  invariant(typeof c.cleanup === 'boolean' && typeof c.compactBetweenWps === 'boolean', 'cleanup and compactBetweenWps must be boolean');
  invariant(typeof c.infrastructure === 'string' && c.infrastructure.length < 16000, 'infrastructure must be less than 16 KB');
  strings(c.agents.workerTools, 'agents.workerTools'); strings(c.agents.reviewerTools, 'agents.reviewerTools'); strings(c.agents.workerExtensions, 'agents.workerExtensions');
  invariant(c.agents.reviewerTools.every(t => ['read', 'grep', 'find', 'ls'].includes(t)), 'Reviewer tools must remain read-only: read, grep, find, ls');
  invariant(c.agents.workerTools.every(t => !['subagent', 'subagents', 'contact_supervisor'].includes(t)), 'Workers must be leaf agents, not nested orchestrators');
  invariant(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(c.agents.thinking), 'Invalid agents.thinking');
  invariant(c.agents.models && typeof c.agents.models === 'object' && !Array.isArray(c.agents.models), 'agents.models must be an object');
  for (const [role, model] of Object.entries(c.agents.models)) invariant(['preflight', 'scout', 'worker', 'correctness', 'architecture', 'tests'].includes(role) && typeof model === 'string' && model.length < 512, `Invalid model override ${role}`);
  for (const [k, n] of Object.entries(c.limits)) {
    invariant(Object.hasOwn(DEFAULTS.limits, k), `Unknown limit ${k}`);
    if (k === 'maxCostUsdPerWp') invariant(n === null || (Number.isFinite(n) && n > 0), `${k} must be positive or null`);
    else invariant(Number.isInteger(n) && n >= 1 && n <= 10000, `${k} must be 1..10000`);
  }
  invariant(c.limits.agentTimeoutMinutes <= 1440, 'Agent timeout may not exceed 24 hours');
  invariant(Number.isInteger(c.ci.timeoutMinutes) && c.ci.timeoutMinutes >= 1 && c.ci.timeoutMinutes <= 1440, 'ci.timeoutMinutes must be 1..1440');
  invariant(Number.isInteger(c.ci.pollSeconds) && c.ci.pollSeconds >= 1 && c.ci.pollSeconds <= 300, 'ci.pollSeconds must be 1..300');
  strings(c.ci.requiredJobs, 'ci.requiredJobs');
  invariant(Object.keys(c.ci).every(k => Object.hasOwn(DEFAULTS.ci, k)), 'Unknown ci option');
  invariant(Object.keys(c.agents).every(k => Object.hasOwn(DEFAULTS.agents, k)), 'Unknown agents option');
  invariant(Array.isArray(c.workPackages) && c.workPackages.length > 0 && c.workPackages.length <= 100, 'workPackages must contain 1..100 WPs');
  const ids = new Set(); let last = -1;
  for (const wp of c.workPackages) {
    invariant(wp && typeof wp === 'object' && Object.keys(wp).every(k => ['id', 'file', 'title', 'checks', 'ui'].includes(k)), 'Unknown WP field');
    invariant(/^WP\d{2,4}$/.test(wp.id) && !ids.has(wp.id), 'Every WP needs a unique WPnn id');
    invariant(Number(wp.id.slice(2)) > last, 'Work packages must be ordered numerically');
    last = Number(wp.id.slice(2)); ids.add(wp.id); relativePath(wp.file, `${wp.id}.file`);
    if (wp.title !== undefined) invariant(typeof wp.title === 'string' && wp.title.length < 200, 'WP title must be <200 characters');
    if (wp.ui !== undefined) invariant(typeof wp.ui === 'boolean', 'WP ui must be boolean');
    if (wp.checks) commands(wp.checks, `${wp.id}.checks`);
  }
  return c;
}
export async function planFiles(dir) {
  const files = [];
  async function walk(current) {
    for (const e of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || ['node_modules', 'artifacts', 'logs'].includes(e.name)) continue;
      const file = path.join(current, e.name);
      invariant(!e.isSymbolicLink(), `Plan cannot include symlinks: ${file}`);
      if (e.isDirectory()) await walk(file);
      else if (/\.(md|txt|json)$/i.test(e.name) && e.name !== 'longtask.json') files.push(file);
    }
  }
  await noSymlinks(dir); await walk(dir);
  invariant(files.length <= 300, 'Plan contains more than 300 input files; narrow the plan directory');
  return files;
}
export async function discoverWps(dir, from = 'WP00', to) {
  const files = await planFiles(dir); const found = new Map();
  for (const absolute of files.filter(f => /\.md$/i.test(f))) {
    const rel = path.relative(dir, absolute).replaceAll('\\', '/');
    const base = path.basename(rel);
    let match = /^(WP\d{2,4})(?:[-_. ]|$)/i.exec(base);
    if (!match && /^readme\.md$/i.test(base)) match = /^(WP\d{2,4})(?:[-_. ]|$)/i.exec(path.basename(path.dirname(absolute)));
    if (!match) continue;
    const id = match[1].toUpperCase();
    if (Number(id.slice(2)) < Number(from.slice(2)) || (to && Number(id.slice(2)) > Number(to.slice(2)))) continue;
    invariant(!found.has(id), `Ambiguous ${id}: ${found.get(id)} and ${rel}. Write workPackages explicitly in longtask.json.`);
    found.set(id, rel);
  }
  invariant(found.size, 'No WPnn Markdown files found. Use examples/longtask.json to define workPackages explicitly.');
  if (to) {
    for (let n = Number(from.slice(2)); n <= Number(to.slice(2)); n++) invariant([...found.keys()].some(id => Number(id.slice(2)) === n), `Missing WP${String(n).padStart(2, '0')} in requested range`);
  }
  return [...found].sort(([a], [b]) => Number(a.slice(2)) - Number(b.slice(2))).map(([id, file]) => ({ id, file }));
}
export async function loadConfig(file, repo) {
  await noSymlinks(file); invariant(within(repo, file), 'Config must be inside the repository');
  const config = validateConfig(JSON.parse(await fs.readFile(file, 'utf8')));
  const planDir = path.dirname(file);
  for (const relative of [config.decisions, ...config.workPackages.map(w => w.file)]) {
    const full = path.resolve(planDir, relative); await noSymlinks(full);
    invariant(await exists(full) && (await fs.stat(full)).isFile(), `Missing plan input: ${full}`);
  }
  const worktreeRoot = path.resolve(repo, config.worktreeRoot); await noSymlinks(worktreeRoot);
  invariant(!within(repo, worktreeRoot) && !within(worktreeRoot, repo), 'worktreeRoot must be outside the repository and not an ancestor of it');
  return { config, planDir, configPath: path.resolve(file), worktreeRoot };
}
export async function inputSnapshot(loaded, repo) {
  const contents = {}; let bytes = 0;
  const inputs = await planFiles(loaded.planDir);
  // Root AGENTS.md is part of the approved repository contract when present.
  if (await exists(path.join(repo, 'AGENTS.md'))) inputs.push(path.join(repo, 'AGENTS.md'));
  for (const file of inputs) {
    const stat = await fs.stat(file); invariant(stat.size <= 1024 * 1024, `Plan input exceeds 1 MB: ${file}`);
    bytes += stat.size; invariant(bytes <= 4 * 1024 * 1024, 'Approved inputs exceed 4 MB');
    contents[path.relative(repo, file).replaceAll('\\', '/')] = await fs.readFile(file, 'utf8');
  }
  const material = JSON.stringify({ config: loaded.config, contents });
  return { digest: hash(material), contents };
}
export function hasUi(config, wp, files) { return wp.ui === true || files.some(f => matchesAny(config.uiPaths, f)); }
export async function initializeConfig(repo, planDir, opts = {}) {
  const absolute = path.resolve(repo, planDir); invariant(within(repo, absolute), 'Plan must be inside this repository');
  await noSymlinks(absolute);
  const file = path.join(absolute, 'longtask.json'); invariant(!await exists(file), `Config already exists: ${file}`);
  const id = path.basename(absolute).replace(/[^a-zA-Z0-9._-]/g, '-');
  const workPackages = await discoverWps(absolute, opts.from ?? 'WP00', opts.to);
  const config = validateConfig({ ...structuredClone(DEFAULTS), id, baseBranch: opts.base ?? 'refactor/arch', branchPrefix: opts.branchPrefix ?? 'dev/refactor-arch', worktreeRoot: opts.worktreeRoot ?? '../brahma00.wt', workPackages });
  if (!await exists(path.join(absolute, config.decisions))) await fs.writeFile(path.join(absolute, config.decisions), '# Approved decisions\n\nRecord the answers to preflight questions here before approving the campaign.\n', { flag: 'wx' });
  await atomicJson(file, config);
  return file;
}
