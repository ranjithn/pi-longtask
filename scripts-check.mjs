import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const name of ['index.js', ...((await readdir('src')).filter(f => f.endsWith('.mjs')).map(f => `src/${f}`))]) {
  const result = spawnSync(process.execPath, ['--check', name], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('All JavaScript modules passed Node syntax checking.');
