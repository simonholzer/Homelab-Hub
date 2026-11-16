// Run the hub on this computer to look at it (npm run local  ->  http://localhost:1212).
// Another port:  node scripts/run-local.mjs 1234   (or PORT=1234)
// Uses config/local.yaml: a copy of config/services.yaml made on the first run (git-ignored),
// so you can play with it without touching the real config.
// On Windows/macOS there is no /proc, so the stats tiles show this computer's own numbers,
// and there is no Docker, so container badges show "?". Service checks are real.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'config', 'services.yaml');
const local = path.join(root, 'config', 'local.yaml');

if (!fs.existsSync(local)) {
  // the server config reads free space from mounted pools; on a laptop use the drive the project is on
  const disk = process.platform === 'win32' ? path.parse(root).root.replace(/\\/g, '/') : '/';
  const text = fs
    .readFileSync(source, 'utf8')
    // the NAS pools don't exist here: show one tile for the drive this project is on
    .replace(/^(  disks:\n)(?:    .*\n|\s*#.*\n)+/m, `$1    - name: This computer\n      path: ${disk}\n`)
    // This is not the NAS: a visit from this computer is "home" only when its public IP is listed.
    .replace('publicIps: []', 'publicIps: []      # put the NAS\'s public IP here, then the preview says Home when this computer is on that line\n    runsAtHome: false');
  fs.writeFileSync(local, text);
  console.log(`[local] created ${local} (edit it freely; delete it to start over from services.yaml)`);
}

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: process.argv[2] ?? process.env.PORT ?? '1212', HOST: process.env.HOST ?? '::', CONFIG_PATH: local, DEFAULT_CONFIG_PATH: source }
});
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
