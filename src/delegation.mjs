import { randomUUID } from 'node:crypto';
import { aborted, invariant } from './util.mjs';
import { agentDefinition } from './prompts.mjs';

// Public pi-subagents contracts, not private imports. Independent Pi packages have
// separate module roots: a second installed package is not a Node dependency.
export const EVENTS = Object.freeze({
  register: 'pi-subagents:runtime-agent-register:v1',
  request: 'prompt-template:subagent:request', started: 'prompt-template:subagent:started',
  update: 'prompt-template:subagent:update', response: 'prompt-template:subagent:response',
  cancel: 'prompt-template:subagent:cancel', rpc: 'subagents:rpc:v1:request',
});
export class UncertainDelegation extends Error { constructor(message) { super(message); this.uncertain = true; } }
export class Subagents {
  constructor(pi, { handshakeMs = 15000, cancelGraceMs = 15000 } = {}) {
    this.pi = pi; this.handshakeMs = handshakeMs; this.cancelGraceMs = cancelGraceMs; this.registrations = []; this.pending = new Set();
  }
  async ping(timeoutMs = 3000) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('No compatible pi-subagents RPC listener. Check /subagents-doctor and update pi-subagents before using longtask.')); }, timeoutMs);
      const off = this.pi.events.on(`subagents:rpc:v1:reply:${requestId}`, reply => {
        if (reply?.requestId !== requestId) return; clearTimeout(timer); off();
        if (!reply.success) reject(new Error(reply.error?.message ?? 'pi-subagents ping failed')); else resolve(reply.data);
      });
      try { this.pi.events.emit(EVENTS.rpc, { version: 1, requestId, method: 'ping', params: {} }); }
      catch (e) { clearTimeout(timer); off(); reject(e); }
    });
  }
  register(settings) {
    invariant(this.pending.size === 0, 'Cannot replace agent definitions while delegation is active');
    this.disposeRegistrations();
    try {
      for (const role of ['preflight', 'scout', 'worker', 'correctness', 'architecture', 'tests']) {
        const request = { version: 1, name: `longtask-${role}`, definition: agentDefinition(role, settings) };
        this.pi.events.emit(EVENTS.register, request);
        invariant(request.result, 'pi-subagents runtime agent registration is unavailable. A newer compatible version is required.');
        if (!request.result.ok) throw request.result.error;
        this.registrations.push(request.result.registration);
      }
    } catch (e) { this.disposeRegistrations(); throw e; }
  }
  disposeRegistrations() { for (const r of this.registrations.splice(0)) r.dispose(); }
  cancelAll() { for (const cancel of [...this.pending]) cancel(); }
  async delegate(request, { signal, onUpdate } = {}) {
    aborted(signal);
    invariant(request.requestId && request.ownerRunId && request.nodeId, 'Delegation needs an exact owned attempt identity');
    return new Promise((resolve, reject) => {
      let settled = false, cancelling = false, cancelTimer;
      const identity = { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId };
      const matches = value => value?.requestId === identity.requestId && value.ownerRunId === identity.ownerRunId && value.nodeId === identity.nodeId;
      const offs = [];
      let handshake, watchdog;
      const cleanup = () => {
        settled = true; clearTimeout(handshake); clearTimeout(watchdog); clearTimeout(cancelTimer);
        for (const off of offs) off(); signal?.removeEventListener('abort', cancel); this.pending.delete(cancel);
      };
      const fail = message => { if (!settled) { cleanup(); reject(new UncertainDelegation(message)); } };
      const cancel = () => {
        if (settled || cancelling) return; cancelling = true; clearTimeout(handshake);
        // Arm before emit: listeners may synchronously acknowledge cancellation.
        cancelTimer = setTimeout(() => fail('Cancellation was not acknowledged. Do not restart a worker until /longtask recover confirms the prior attempt stopped.'), this.cancelGraceMs);
        try { this.pi.events.emit(EVENTS.cancel, identity); }
        catch (e) { fail(`Could not send child cancellation: ${e.message}`); }
      };
      offs.push(this.pi.events.on(EVENTS.started, event => { if (matches(event)) clearTimeout(handshake); }));
      offs.push(this.pi.events.on(EVENTS.update, event => {
        if (matches(event)) { clearTimeout(handshake); try { onUpdate?.(event); } catch {} }
      }));
      offs.push(this.pi.events.on(EVENTS.response, event => {
        // invalid_request can contain only requestId; the random request ID still
        // correlates rejection of this attempt. Other responses need all three IDs.
        if (!matches(event) && !(event?.status === 'invalid_request' && event.requestId === identity.requestId)) return;
        cleanup(); resolve(event);
      }));
      handshake = setTimeout(cancel, this.handshakeMs);
      watchdog = setTimeout(cancel, (request.timeoutMs ?? 1800000) + 30000);
      this.pending.add(cancel); signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      try { this.pi.events.emit(EVENTS.request, request); }
      catch (e) { cancel(); }
    });
  }
}
