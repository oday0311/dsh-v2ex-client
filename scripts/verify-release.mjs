import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commands = ['typecheck', 'build', 'test', 'test:integration', 'test:e2e', 'verify:package'];

for (const command of commands) {
  execFileSync('pnpm', ['run', command], { cwd: root, stdio: 'inherit' });
}
