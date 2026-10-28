import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Web Functions starts Node.js; the bundled Python server owns the HTTP port.
const root = fileURLToPath(new URL('.', import.meta.url));
const server = spawn(`${root}python/bin/python3`, [`${root}server.py`], {
  cwd: root,
  env: {
    ...process.env,
    PYTHONPATH: `${root}dependencies`,
    PYTHONDONTWRITEBYTECODE: '1',
  },
  stdio: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.kill(signal));
}
server.on('error', () => {
  console.error('Python server could not start');
  process.exit(1);
});
server.on('exit', (code, signal) =>
  process.exit(signal === 'SIGTERM' ? 0 : (code ?? 1))
);
