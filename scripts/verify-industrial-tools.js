const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { executeTool } = require('../dist/integrations/tools');

const root = path.resolve(__dirname, '..');
const fixtureDir = path.join(root, '.maos', 'industrial-tool-verification');
fs.mkdirSync(fixtureDir, { recursive: true });

function run(name, args) {
  return JSON.parse(executeTool(name, args, root, ['/'], 'verification', 'P1-07').result);
}

try {
  fs.writeFileSync(path.join(fixtureDir, 'sample.txt'), 'bearing inspection complete', 'utf8');
  fs.writeFileSync(path.join(fixtureDir, 'sample.csv'), 'sensor,value\n"bearing, axial",8.5\n', 'utf8');
  fs.writeFileSync(path.join(fixtureDir, 'sample.json'), JSON.stringify({ asset: 'T-01' }), 'utf8');
  fs.writeFileSync(path.join(fixtureDir, 'sample.pdf'), 'not a real PDF', 'utf8');

  assert.equal(run('ingest_document', { path: '.maos/industrial-tool-verification/sample.txt' }).ok, true);
  assert.equal(run('ingest_document', { path: '.maos/industrial-tool-verification/sample.csv' }).rows[0][0], 'bearing, axial');
  assert.equal(run('ingest_document', { path: '.maos/industrial-tool-verification/sample.json' }).data.asset, 'T-01');
  assert.match(run('ingest_document', { path: '.maos/industrial-tool-verification/sample.pdf' }).error, /PDF extraction unavailable|pdftotext/i);
  assert.equal(run('ingest_document', { path: '../outside.txt' }).ok, false);

  const thresholds = { vibration: { unit: 'mm/s', warning: 7.1, critical: 9.0 } };
  assert.equal(run('check_compliance', { measurements: { vibration: 7.0 }, thresholds }).status, 'PASS');
  assert.equal(run('check_compliance', { measurements: { vibration: 7.1 }, thresholds }).status, 'WARNING');
  assert.equal(run('check_compliance', { measurements: { vibration: 9.0 }, thresholds }).status, 'FAIL');

  const python = run('execute_python', { script: 'print("industrial-python-ok")' });
  assert.equal(python.ok, true, python.stderr);
  assert.match(python.stdout, /industrial-python-ok/);
  assert.equal(fs.readdirSync(path.join(root, '.maos', 'industrial-sandbox')).filter(name => name.endsWith('.py')).length, 0);
  if (process.argv.includes('--timeout')) {
    const timeout = run('execute_python', { script: 'import time\ntime.sleep(35)' });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.timedOut, true);
  }
  console.log('Industrial tool verification passed: ingestion, path rejection, exact thresholds, Python execution, cleanup.');
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
