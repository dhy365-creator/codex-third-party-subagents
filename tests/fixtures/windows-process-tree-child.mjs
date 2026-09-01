import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--leaf') {
  setInterval(() => {}, 1000);
} else {
  const fixturePath = fileURLToPath(import.meta.url);
  const leaf = spawn(process.execPath, [fixturePath, '--leaf'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  process.stdout.write(`${JSON.stringify({ parentPid: process.pid, childPid: leaf.pid })}\n`);
  setInterval(() => {}, 1000);
}
