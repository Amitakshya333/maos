const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (!fs.existsSync(path.join(process.cwd(), '.git'))) process.exit(0);

const husky = path.join(process.cwd(), 'node_modules', 'husky', 'bin.js');
if (!fs.existsSync(husky)) throw new Error('Husky is required when preparing hooks in a Git checkout.');
const result = spawnSync(process.execPath, [husky], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
