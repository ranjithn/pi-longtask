import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const now = () => new Date().toISOString();
export const hash = value => createHash('sha256').update(value).digest('hex');
export const errorText = error => error instanceof Error ? error.message : String(error);
export function invariant(condition, message) { if (!condition) throw new Error(message); }
export function aborted(signal) { if (signal?.aborted) throw signal.reason ?? new Error('Stopped'); }
export const exists = async file => { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync(); await handle.close(); handle = null;
    await fs.rename(tmp, file);
    // Best effort: directory fsync is unavailable on some filesystems.
    try { const dir = await fs.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch {}
  } finally { await handle?.close(); await fs.rm(tmp, { force: true }); }
}
export function within(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function relativePath(value, label) {
  invariant(typeof value === 'string' && value.length > 0 && !value.includes('\0'), `${label} must be a nonempty path`);
  invariant(!path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'), `${label} must stay inside the repository`);
  return value.replaceAll('\\', '/');
}
export async function noSymlinks(candidate) {
  const absolute = path.resolve(candidate);
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep);
  let cursor = path.parse(absolute).root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try { invariant(!(await fs.lstat(cursor)).isSymbolicLink(), `Symlink path is not allowed: ${cursor}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
export function matchGlob(pattern, name) {
  // Deliberately small glob language: *, **, ?; no braces or extglobs.
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(re + '$').test(name.replaceAll('\\', '/'));
}
export const matchesAny = (patterns, name) => patterns.some(p => matchGlob(p, name));
export function splitArgs(input) {
  const out = []; let current = ''; let quote = ''; let escaped = false; let begun = false;
  for (const c of input.trim()) {
    if (escaped) { current += c; escaped = false; begun = true; }
    else if (c === '\\' && quote !== "'") { escaped = true; begun = true; }
    else if (quote) { if (c === quote) quote = ''; else current += c; }
    else if (c === '"' || c === "'") { quote = c; begun = true; }
    else if (/\s/.test(c)) { if (begun) { out.push(current); current = ''; begun = false; } }
    else { current += c; begun = true; }
  }
  invariant(!escaped && !quote, 'Unclosed quote or escape in command');
  if (begun) out.push(current);
  return out;
}
export async function sleep(ms, signal) {
  aborted(signal);
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Stopped')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export class CommandError extends Error {
  constructor(argv, result) { super(`${argv[0]} failed (${result.timedOut ? 'timeout' : result.code}): ${(result.stderr || result.stdout).slice(-3000)}`); this.result = result; }
}
export async function command(argv, options = {}) {
  const { cwd, signal, timeoutMs = 120000, env = {}, allowFailure = false, maxBytes = 8 * 1024 * 1024, onSpawn, onExit } = options;
  invariant(Array.isArray(argv) && argv.length && argv.every(a => typeof a === 'string' && !a.includes('\0')), 'Invalid command argv');
  aborted(signal);
  const start = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, overflow = false, killTimer, closed = false;
    let stopRequested = false;
    function kill(sig) { try { process.platform !== 'win32' ? process.kill(-child.pid, sig) : child.kill(sig); } catch (e) { if (e.code !== 'ESRCH') { /* close/error handlers remain authoritative */ } } }
    const stop = () => {
      if (closed || stopRequested) return;
      stopRequested = true; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const cleanup = () => { closed = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); };
    signal?.addEventListener('abort', stop, { once: true });
    // Account for an abort occurring between the initial check and listener setup.
    if (signal?.aborted) stop();
    child.once('spawn', () => { try { onSpawn?.(child.pid); } catch { stop(); } });
    for (const [stream, key] of [[child.stdout, 'out'], [child.stderr, 'err']]) {
      stream.setEncoding('utf8'); stream.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) { overflow = true; stop(); return; }
        if (key === 'out') stdout += chunk; else stderr += chunk;
      });
    }
    child.once('error', e => { cleanup(); reject(e); });
    child.once('close', (code, exitSignal) => {
      cleanup();
      try { onExit?.(); } catch {}
      resolve({ argv, code, signal: exitSignal, stdout, stderr, timedOut, overflow, durationMs: Date.now() - start });
    });
  });
  aborted(signal);
  if (result.overflow) throw new Error(`Command output exceeded ${maxBytes} bytes; stopped ${argv[0]}`);
  if ((result.code !== 0 || result.timedOut) && !allowFailure) throw new CommandError(argv, result);
  return result;
}
export async function acquireLock(file, description) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const value = { token: randomUUID(), pid: process.pid, host: os.hostname(), startedAt: now(), ...description };
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let lock; try { lock = await readJson(file); } catch { lock = { state: 'unreadable' }; }
    throw new Error(`Repository is locked: ${JSON.stringify(lock)}. Use /longtask recover only after checking that prior workers have stopped.`);
  }
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  return async () => { try { if ((await readJson(file)).token === value.token) await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
}
export async function removeDeadLock(file) {
  if (!await exists(file)) return;
  const lock = await readJson(file);
  invariant(lock.host === os.hostname(), `Lock belongs to another host (${lock.host}); inspect shared storage manually`);
  invariant(Number.isInteger(lock.pid) && lock.pid > 0, 'Malformed lock; inspect it manually');
  let dead = false;
  try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') dead = true; }
  invariant(dead, `PID ${lock.pid} still exists. Stop that Pi process before recovering.`);
  await fs.unlink(file);
}
