import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import install from '../index.js';
import { bus, fixture } from './helpers.mjs';
function host(cwd = '/tmp') {
  const commands = new Map(); const events = new Map(); const messages = []; const errors = [];
  const pi = {
    events: bus(), registerCommand: (name, value) => commands.set(name, value), on: (name, fn) => events.set(name, fn),
    sendMessage: (msg, opts) => messages.push({ msg, opts }), appendEntry() {}, getAllTools: () => [],
  };
  const ctx = { cwd, hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    ui: { setStatus() {}, notify: (text, type) => errors.push({ text, type }), confirm: async () => false },
  };
  install(pi); return { pi, commands, events, messages, errors, ctx };
}
test('Pi factory registers the command and lifecycle hooks without launching work', async () => {
  const h = host(); assert.equal(h.messages.length, 0);
  assert.ok(h.commands.has('longtask')); assert.ok(h.events.has('session_before_tree'));
  await h.commands.get('longtask').handler('help', h.ctx);
  assert.match(h.messages[0].msg.content, /longtask run/);
  assert.equal(h.messages[0].opts.triggerTurn, false);
  await h.events.get('session_shutdown')(); assert.equal(h.errors.length, 0);
});
test('Pi use/status/dry-run commands read a campaign without invoking a worker', async t => {
  const f = await fixture(t, { count: 1 }); const h = host(f.root);
  const handler = h.commands.get('longtask').handler;
  await handler(`use "${path.relative(f.root, f.plan)}"`, h.ctx);
  await handler('status', h.ctx); await handler('dry-run', h.ctx);
  assert.equal(h.errors.length, 0);
  assert.ok(h.messages.some(m => m.msg.content.includes('WP00')));
  assert.equal(f.subagents.calls.filter(r => r.agent === 'longtask-worker').length, 0);
});
