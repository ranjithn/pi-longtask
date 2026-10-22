import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { fixture } from './helpers.mjs';
import { readJson } from '../src/util.mjs';
test('stale controller cannot overwrite a newer durable checkpoint', async t => {
  const f = await fixture(t, { count: 1 });
  const stale = new Store(f.repo, 'arch'); await stale.load(f.configPath);
  f.e.state.note = 'newer'; await f.e.store.save({ type: 'test-newer' });
  await assert.rejects(stale.assertFresh(), /another controller/);
  stale.state.note = 'stale'; await assert.rejects(stale.save(), /another controller/);
  assert.equal((await readJson(stale.stateFile)).note, 'newer');
});
test('queued parallel saves use monotonically increasing durable revisions', async t => {
  const f = await fixture(t, { count: 1 }); const before = f.e.store.persistedRevision;
  await Promise.all(Array.from({ length: 5 }, (_, n) => f.e.store.save({ type: 'parallel', n })));
  assert.equal(f.e.store.persistedRevision, before + 5);
  assert.equal((await readJson(f.e.store.stateFile)).revision, before + 5);
});
