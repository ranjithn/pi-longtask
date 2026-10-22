import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Subagents } from '../src/delegation.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { SCHEMAS, validateResult } from '../src/prompts.mjs';

// Opt in with installed package roots; no peer copies or credentials are needed.
const piRoot = process.env.LONGTASK_PI_PATH;
const subagentsRoot = process.env.LONGTASK_SUBAGENTS_PATH;
test('installed Pi and pi-subagents load longtask and execute structured leaves', {
  skip: !piRoot || !subagentsRoot ? 'Set LONGTASK_PI_PATH and LONGTASK_SUBAGENTS_PATH to installed package roots' : false,
  timeout: 60000,
}, async t => {
  // The SDK host is this test file, not Pi's CLI; tell subagents where its host peers live.
  const hostRootKey = 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT';
  const previousHostRoot = process.env[hostRootKey];
  process.env[hostRootKey] = piRoot;
  t.after(() => { if (previousHostRoot === undefined) delete process.env[hostRootKey]; else process.env[hostRootKey] = previousHostRoot; });
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(pathToFileURL(path.join(piRoot, 'dist/index.js')).href);
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'longtask-compat-'));
  let bridge, session;
  t.after(async () => {
    try {
      bridge?.cancelAll();
      if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    } finally {
      bridge?.disposeRegistrations();
      session?.dispose();
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
  const versions = await Promise.all([piRoot, subagentsRoot].map(async root => JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version));
  t.diagnostic(`Pi ${versions[0]}, pi-subagents ${versions[1]}`);
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: 'longtask-test', defaultModel: 'leaf',
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const values = {
    preflight: { summary: 'Audited', questions: [], risks: [] },
    scout: { summary: 'Scouted', files: [], risks: [] },
    worker: { status: 'done', summary: 'Implemented', tests: [], blockers: [] },
    review: { verdict: 'pass', summary: 'Reviewed', findings: [] },
  };
  let providerCalls = 0;
  const errors = [];
  const loader = new DefaultResourceLoader({
    cwd: temp, agentDir: path.join(temp, 'agent'), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [path.join(subagentsRoot, 'index.js'), fileURLToPath(new URL('../index.js', import.meta.url))],
    extensionFactories: [pi => {
      bridge = new Subagents(pi, { handshakeMs: 10000, cancelGraceMs: 1000 });
      pi.registerProvider('longtask-test', {
        api: 'longtask-test-api', apiKey: 'test-only', baseUrl: 'https://unused.invalid',
        models: [{ id: 'leaf', name: 'Deterministic test leaf', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
        streamSimple: (model, context) => {
          providerCalls++;
          assert.ok(providerCalls <= 12, 'Unexpected child retry loop');
          const tools = new Map();
          for (const message of context.messages) {
            if (message.role !== 'system') continue;
            for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
            for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
          }
          const tool = tools.get('structured_output');
          assert.ok(tool, 'Child must expose the real structured output protocol tool');
          const schema = tool.parameters.properties.value;
          const role = Object.hasOwn(schema.properties, 'questions') ? 'preflight'
            : Object.hasOwn(schema.properties, 'files') ? 'scout'
              : Object.hasOwn(schema.properties, 'status') ? 'worker' : 'review';
          const finished = context.messages.some(message => message.role === 'toolResult' && message.toolName === 'structured_output');
          const message = {
            role: 'assistant', api: model.api, provider: model.provider, model: model.id,
            content: finished ? [{ type: 'text', text: 'Done.' }] : [{ type: 'toolCall', id: randomUUID(), name: tool.name, arguments: { value: values[role] } }],
            stopReason: finished ? 'stop' : 'toolUse', timestamp: Date.now(),
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'start', partial: message };
              if (!finished) {
                yield { type: 'toolcall_start', contentIndex: 0, partial: message };
                yield { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(message.content[0].arguments), partial: message };
                yield { type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0], partial: message };
              }
              yield { type: 'done', reason: message.stopReason, message };
            },
            result: async () => message,
          };
        },
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd: temp, agentDir: path.join(temp, 'agent'), settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(temp), tools: [],
  }));
  await session.bindExtensions({ onError: error => errors.push(error) });
  assert.ok(session.extensionRunner.getRegisteredCommands().some(command => command.name === 'longtask'));
  await session.prompt('/longtask help');
  assert.ok(session.messages.some(message => message.customType === 'longtask'));
  assert.equal(providerCalls, 0, 'The help command must not call a model');
  await bridge.ping();
  bridge.register(DEFAULTS.agents);
  for (const role of ['preflight', 'scout', 'worker', 'correctness', 'architecture', 'tests']) {
    const schema = SCHEMAS[role] ?? SCHEMAS.review;
    const response = await bridge.delegate({
      requestId: randomUUID(), ownerRunId: 'compat', nodeId: role,
      agent: `longtask-${role}`, cwd: temp, task: 'Return the test structured result.',
      context: 'fresh', model: 'longtask-test/leaf', thinking: 'off', skill: false,
      artifacts: true, timeoutMs: 10000, toolBudget: { hard: 2, block: '*' },
      intercomBridge: { mode: 'off' }, result: { kind: 'structured', schema },
    });
    assert.equal(response.status, 'completed', JSON.stringify(response));
    assert.equal(response.result?.kind, 'structured');
    validateResult(schema, response.result.value);
    assert.equal(response.usage?.cost, 0);
  }
  assert.equal(providerCalls, 6);
  assert.deepEqual(errors, []);
});
