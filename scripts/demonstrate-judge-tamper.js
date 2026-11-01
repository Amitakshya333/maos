#!/usr/bin/env node
/**
 * MAOS Industrial — Judge Tamper Demonstration
 *
 * Demonstrates the "don't trust it — verify it" invariant:
 * 1. Verifies an authentic judged-run audit export -> PASS
 * 2. Creates a temporary copy and alters exactly ONE numeric field -> FAIL (Closed)
 * 3. Reports the exact differing check (hash mismatch from canonical serialization)
 * 4. Confirms the original export artifact is completely untouched
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { createServiceContainer } = require('../dist/service');
const { executeJudgedRun, verifyAuditExport } = require('../dist/industrial/judged-run');
const { INDUSTRIAL_CLI_EXIT } = require('../dist/industrial/industrial-cli');

async function main() {
  console.log('\n===============================================================');
  console.log('  MAOS Industrial — Judge Verifier & Tamper Demonstration');
  console.log('===============================================================\n');

  // Parse CLI args for existing export path
  let exportPath = null;
  let projectRoot = path.resolve(__dirname, '..');
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--export' && args[i + 1]) {
      exportPath = path.resolve(args[i + 1]);
      i++;
    } else if (args[i] === '--project-root' && args[i + 1]) {
      projectRoot = path.resolve(args[i + 1]);
      i++;
    }
  }

  let cleanupDir = null;
  if (!exportPath) {
    console.log('[Setup] No --export specified. Preparing clean isolated project and running T-07 safety audit...');
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-judge-tamper-demo-'));
    fs.mkdirSync(path.join(cleanupDir, '.maos'), { recursive: true });
    fs.writeFileSync(
      path.join(cleanupDir, '.maos', 'maos.config.json'),
      JSON.stringify({ projectName: 'judge-tamper-demo' }, null, 2),
    );
    const demoDir = path.join(cleanupDir, 'demo', 'industrial');
    fs.mkdirSync(demoDir, { recursive: true });
    for (const name of [
      'safety_thresholds.json',
      'turbine_vibration_log.csv',
      'maintenance_report.txt',
      'turbine_inspection_scan.pdf',
    ]) {
      fs.copyFileSync(path.join(projectRoot, 'demo', 'industrial', name), path.join(demoDir, name));
    }

    const services = createServiceContainer(cleanupDir);
    const runResult = await executeJudgedRun({
      projectRoot: cleanupDir,
      services,
      autoApprove: true,
      yes: true,
      json: true,
    });

    if (!runResult.success || !runResult.auditExportPath) {
      console.error('Failed to generate baseline judged run for demo:', runResult.message);
      process.exit(1);
    }

    exportPath = path.join(cleanupDir, runResult.auditExportPath);
    projectRoot = cleanupDir;
    console.log(`[Setup] T-07 judged run complete: ${runResult.runId}\n`);
  }

  try {
    // Record original file hash
    const originalBytes = fs.readFileSync(exportPath);
    const originalSha256 = crypto.createHash('sha256').update(originalBytes).digest('hex');

    // ─────────────────────────────────────────────────────────────
    // STEP 1: Verify Original Export
    // ─────────────────────────────────────────────────────────────
    console.log('---------------------------------------------------------------');
    console.log('STEP 1: Verifying Original Authentic Audit Export');
    console.log('---------------------------------------------------------------');
    console.log(`Export Path:     ${path.relative(process.cwd(), exportPath)}`);
    console.log(`Original SHA256: ${originalSha256}`);

    const originalVerification = verifyAuditExport(exportPath, { projectRoot });
    console.log(`Verification:    ${originalVerification.valid ? 'PASS' : 'FAIL'}`);
    console.log(`Run ID:          ${originalVerification.runId || 'none'}`);
    console.log(`Record Count:    ${originalVerification.recordCount}`);
    console.log(`Latest Hash:     ${originalVerification.latestHash}`);
    console.log(`Deliverable:     ${originalVerification.deliverablePath || 'none'} (Verified: ${originalVerification.deliverableVerified})`);
    console.log(`Deliverable SHA: ${originalVerification.deliverableSha256 || 'none'}`);

    if (!originalVerification.valid) {
      console.error('Original export verification unexpectedly failed!');
      for (const err of originalVerification.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
    console.log('\n>> RESULT: Original export PASSED all cryptographic and evidence checks.\n');

    // ─────────────────────────────────────────────────────────────
    // STEP 2: Create Isolated Temporary Copy
    // ─────────────────────────────────────────────────────────────
    const tempCopyPath = path.join(os.tmpdir(), `tampered-export-${Date.now()}.json`);
    console.log('---------------------------------------------------------------');
    console.log('STEP 2: Creating Temporary Isolated Copy for Tamper Demonstration');
    console.log('---------------------------------------------------------------');
    console.log(`Copy Path:       ${tempCopyPath}`);

    const exportData = JSON.parse(originalBytes.toString('utf8'));

    // ─────────────────────────────────────────────────────────────
    // STEP 3: Alter Exactly One Numeric Field
    // ─────────────────────────────────────────────────────────────
    console.log('---------------------------------------------------------------');
    console.log('STEP 3: Altering Exactly One Numeric Field in Copy');
    console.log('---------------------------------------------------------------');

    // Locate a record with numeric payload data
    let tamperedRecordIndex = -1;
    let tamperedFieldName = '';
    let oldValue = null;
    let newValue = null;

    for (let i = 0; i < exportData.records.length; i++) {
      const rec = exportData.records[i];
      if (rec.data && typeof rec.data === 'object') {
        for (const [key, val] of Object.entries(rec.data)) {
          if (typeof val === 'number') {
            tamperedRecordIndex = i;
            tamperedFieldName = key;
            oldValue = val;
            newValue = val + 1;
            rec.data[key] = newValue;
            break;
          }
        }
        if (tamperedRecordIndex >= 0) break;
      }
    }

    if (tamperedRecordIndex < 0) {
      console.error('Could not find any numeric field to alter in records.');
      process.exit(1);
    }

    console.log(`Target Record:   Index ${tamperedRecordIndex} (sequence ${exportData.records[tamperedRecordIndex].sequence})`);
    console.log(`Field Altered:   record.data.${tamperedFieldName}`);
    console.log(`Original Value:  ${oldValue}`);
    console.log(`Tampered Value:  ${newValue} (value incremented by 1)`);

    fs.writeFileSync(tempCopyPath, JSON.stringify(exportData, null, 2), 'utf8');

    // ─────────────────────────────────────────────────────────────
    // STEP 4: Verify Tampered Copy
    // ─────────────────────────────────────────────────────────────
    console.log('---------------------------------------------------------------');
    console.log('STEP 4: Verifying Tampered Copy (Expecting Fail-Closed)');
    console.log('---------------------------------------------------------------');

    const tamperedVerification = verifyAuditExport(tempCopyPath, { projectRoot });
    console.log(`Verification:    ${tamperedVerification.valid ? 'PASS' : 'FAIL (Closed)'}`);
    console.log(`Exit Code:       ${tamperedVerification.valid ? INDUSTRIAL_CLI_EXIT.SUCCESS : INDUSTRIAL_CLI_EXIT.VERIFY_FAILED}`);
    console.log('Differing Checks Reported:');
    for (const err of tamperedVerification.errors) {
      console.log(`  ✗ ${err}`);
    }

    if (tamperedVerification.valid) {
      console.error('\nERROR: Tampered copy unexpectedly passed verification!');
      process.exit(1);
    }
    console.log('\n>> RESULT: Tampered copy FAILED CLOSED as expected.');

    // ─────────────────────────────────────────────────────────────
    // STEP 5: Confirm Original Artifact is Untouched
    // ─────────────────────────────────────────────────────────────
    console.log('---------------------------------------------------------------');
    console.log('STEP 5: Confirming Original Artifact Remains Untouched');
    console.log('---------------------------------------------------------------');

    const postVerifyBytes = fs.readFileSync(exportPath);
    const postVerifySha256 = crypto.createHash('sha256').update(postVerifyBytes).digest('hex');
    console.log(`Original SHA256 Before: ${originalSha256}`);
    console.log(`Original SHA256 After:  ${postVerifySha256}`);

    if (originalSha256 !== postVerifySha256) {
      console.error('ERROR: Original export artifact was modified!');
      process.exit(1);
    }
    console.log('Integrity:       MATCH (0 bytes modified)');

    // Clean up temporary copy
    if (fs.existsSync(tempCopyPath)) fs.unlinkSync(tempCopyPath);

    console.log('\n===============================================================');
    console.log('  DEMONSTRATION COMPLETE: ALL INVARIANTS VERIFIED');
    console.log('  1. Authentic export passes verification.');
    console.log('  2. Single numeric change causes fail-closed hash rejection.');
    console.log('  3. Authoritative Rust engine reports exact mismatch.');
    console.log('  4. Original artifact is never modified.');
    console.log('===============================================================\n');
  } finally {
    if (cleanupDir && fs.existsSync(cleanupDir)) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error('Unexpected demonstration failure:', err);
  process.exit(1);
});
