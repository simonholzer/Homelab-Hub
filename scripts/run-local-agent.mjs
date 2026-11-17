// Run an agent on this computer next to `npm run local`, to try "Found on the network" and stats
// from another machine without a second machine (npm run local-agent  ->  port 8081).
// Another port:  node scripts/run-local-agent.mjs 8082.  With Docker here: set DOCKER_HOST too.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, HUB_MODE: 'agent', PORT: process.argv[2] ?? process.env.PORT ?? '8081', AGENT_NAME: process.env.AGENT_NAME ?? 'Local test agent' }
});
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
