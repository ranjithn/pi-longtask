import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, Subagents } from '../src/delegation.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { bus } from './helpers.mjs';

const request = () => ({ requestId: 'a', ownerRunId: 'campaign', nodeId: 'WP00-worker', agent: 'longtask-worker', task: 'test', cwd: '/tmp', context: 'fresh', timeoutMs: 500, result: { kind: 'structured', schema: { type: 'object' } } });
const completed = r => ({ requestId: r.requestId, ownerRunId: r.ownerRunId, nodeId: r.nodeId, status: 'completed', result: { kind: 'structured', value: {} } });

test('delegation correlates all identity fields and disposes listeners', async () => {
  const events = bus(); const bridge = new Subagents({ events }, { handshakeMs: 100, cancelGraceMs: 20 });
  events.on(EVENTS.request, r => {
    events.emit(EVENTS.started, r);
    events.emit(EVENTS.response, { ...completed(r), ownerRunId: 'another-campaign', status: 'failed' });
    events.emit(EVENTS.response, completed(r));
  });
  assert.equal((await bridge.delegate(request())).status, 'completed'); assert.equal(events.listenerCount(EVENTS.response), 0); assert.equal(bridge.pending.size, 0);
});
test('cancellation awaits the exact child terminal acknowledgement', async () => {
  const events = bus(); const c = new AbortController(); const bridge = new Subagents({ events }, { handshakeMs: 100, cancelGraceMs: 20 });
  events.on(EVENTS.request, r => { events.emit(EVENTS.started, r); setTimeout(() => c.abort(new Error('stop')), 2); });
  events.on(EVENTS.cancel, identity => events.emit(EVENTS.response, { ...identity, status: 'cancelled' }));
  assert.equal((await bridge.delegate(request(), { signal: c.signal })).status, 'cancelled'); assert.equal(bridge.pending.size, 0);
});
test('unacknowledged cancellation remains uncertain rather than claiming a stop', async () => {
  const events = bus(); const bridge = new Subagents({ events }, { handshakeMs: 5, cancelGraceMs: 5 });
  await assert.rejects(bridge.delegate(request()), e => e.uncertain === true); assert.equal(bridge.pending.size, 0);
});
test('invalid-request response can reject by unique requestId only', async () => {
  const events = bus(); const bridge = new Subagents({ events });
  events.on(EVENTS.request, r => events.emit(EVENTS.response, { requestId: r.requestId, status: 'invalid_request', error: 'schema' }));
  assert.equal((await bridge.delegate(request())).status, 'invalid_request');
});
test('runtime agents register through the installed owner, not an imported copy', () => {
  const events = bus(); const definitions = []; let disposed = 0;
  events.on(EVENTS.register, r => { definitions.push(r); r.result = { ok: true, registration: { dispose: () => disposed++ } }; });
  const bridge = new Subagents({ events }); bridge.register(DEFAULTS.agents);
  assert.equal(definitions.length, 6); assert.equal(definitions.find(r => r.name === 'longtask-worker').definition.allowNestedSubagents, false);
  assert.deepEqual(definitions.find(r => r.name === 'longtask-correctness').definition.tools, ['read', 'grep', 'find', 'ls']);
  bridge.disposeRegistrations(); assert.equal(disposed, 6);
});
test('missing compatible runtime-registration owner fails closed', () => {
  const bridge = new Subagents({ events: bus() }); assert.throws(() => bridge.register(DEFAULTS.agents), /unavailable/);
});
