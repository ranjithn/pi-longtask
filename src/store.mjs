import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, exists, invariant, now, readJson } from './util.mjs';

export class Store {
  constructor(repo, id) {
    this.repo = repo; this.dir = path.join(repo.commonDir, 'pi-longtask', id);
    this.stateFile = path.join(this.dir, 'state.json');
    this.lockFile = path.join(repo.commonDir, 'pi-longtask', 'controller.lock');
    this.queue = Promise.resolve();
  }
  async load(configPath) {
    this.state = await exists(this.stateFile) ? await readJson(this.stateFile) : {
      version: 1, configPath, status: 'draft', createdAt: now(), approval: null,
      current: 0, workPackages: [], activeAttempts: {}, preflight: null,
    };
    invariant(this.state.version === 1, 'Unsupported saved state version');
    invariant(this.state.configPath === configPath, 'Campaign ID collides with another config. Choose a unique id.');
    this.persistedRevision = this.state.revision ?? 0;
    return this.state;
  }
  async assertFresh() {
    await this.queue;
    const disk = await exists(this.stateFile) ? await readJson(this.stateFile) : null;
    invariant((disk?.revision ?? 0) === this.persistedRevision, 'Campaign state changed in another controller. Reload it before continuing.');
  }
  save(event) {
    this.state.updatedAt = now(); const snapshot = structuredClone(this.state);
    this.queue = this.queue.then(async () => {
      const disk = await exists(this.stateFile) ? await readJson(this.stateFile) : null;
      invariant((disk?.revision ?? 0) === this.persistedRevision, 'Campaign state changed in another controller. Reload it before continuing.');
      snapshot.revision = this.persistedRevision + 1;
      await atomicJson(this.stateFile, snapshot);
      this.persistedRevision = snapshot.revision;
      this.state.revision = snapshot.revision;
      if (event) await fs.appendFile(path.join(this.dir, 'events.jsonl'), JSON.stringify({ at: now(), ...event }) + '\n', { mode: 0o600 });
    });
    return this.queue;
  }
  async artifact(name, value) {
    invariant(/^[A-Za-z0-9._-]+$/.test(name), 'Unsafe artifact name');
    await fs.mkdir(path.join(this.dir, 'artifacts'), { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, 'artifacts', name);
    if (typeof value === 'string') await fs.writeFile(file, value, { mode: 0o600 });
    else await atomicJson(file, value);
    return file;
  }
  async snapshotInputs(snapshot) {
    const dir = path.join(this.dir, 'inputs');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const [rel, content] of Object.entries(snapshot.contents)) {
      const dest = path.join(dir, rel); await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.writeFile(dest, content, { mode: 0o600 });
    }
    await atomicJson(path.join(this.dir, 'inputs.json'), { digest: snapshot.digest, files: Object.keys(snapshot.contents) });
    return dir;
  }
}
