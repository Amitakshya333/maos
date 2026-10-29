import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { validateProjectFolder } from '../../src/service/project-service/validator';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
const packageFiles = packageJson.files as string[];
const npmIgnore = fs.readFileSync(path.join(PROJECT_ROOT, '.npmignore'), 'utf8');

describe('Industrial npm runtime assets', () => {
  it('ships all four T-07 demo inputs needed by the judged workflow', () => {
    for (const asset of [
      'demo/industrial/safety_thresholds.json',
      'demo/industrial/turbine_vibration_log.csv',
      'demo/industrial/maintenance_report.txt',
      'demo/industrial/turbine_inspection_scan.pdf',
    ]) {
      expect(packageFiles).toContain(asset);
      expect(fs.existsSync(path.join(PROJECT_ROOT, asset))).toBe(true);
    }
  });

  it('ships the Industrial profile required to enable browser evidence analysis', () => {
    const profilePath = 'profiles/industrial/maos.config.json';
    expect(packageFiles).toContain(profilePath);
    const profile = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, profilePath), 'utf8'));
    expect(profile.schemaVersion).toBe(1);
    expect(profile.profile.id).toBe('industrial');
    expect(profile.profile.evidenceRoot).toBe('demo/industrial');
  });

  it('passes the same project-folder schema gate used by the authenticated launcher', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-industrial-profile-'));
    try {
      const maosRoot = path.join(projectRoot, '.maos');
      fs.mkdirSync(maosRoot, { recursive: true });
      fs.copyFileSync(
        path.join(PROJECT_ROOT, 'profiles/industrial/maos.config.json'),
        path.join(maosRoot, 'maos.config.json'),
      );
      const result = validateProjectFolder(projectRoot, { allowTemp: true });
      expect(result.valid).toBe(true);
      expect(result.code).toBeUndefined();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('ships the operator documents linked from the README and runbook', () => {
    const readme = fs.readFileSync(path.join(PROJECT_ROOT, 'README.md'), 'utf8');
    const runbook = fs.readFileSync(path.join(PROJECT_ROOT, 'demo/industrial/RUNBOOK.md'), 'utf8');
    for (const asset of [
      'demo/industrial/RUNBOOK.md',
      'demo/industrial/PRESENTATION_SCRIPT.md',
      'docs/BOUNDARY_SCOPE.md',
    ]) {
      expect(packageFiles).toContain(asset);
      expect(fs.existsSync(path.join(PROJECT_ROOT, asset))).toBe(true);
    }
    expect(readme).toContain('demo/industrial/RUNBOOK.md');
    expect(readme).toContain('demo/industrial/PRESENTATION_SCRIPT.md');
    expect(runbook).toContain('../../docs/BOUNDARY_SCOPE.md');
  });

  it('includes built GUI and Python assets but excludes Python bytecode caches', () => {
    expect(packageFiles).toContain('dist/');
    expect(packageFiles).toContain('!**/__pycache__/**');
    expect(packageFiles).toContain('!**/*.pyc');
    expect(npmIgnore).toContain('**/__pycache__/');
    expect(npmIgnore).toContain('**/*.pyc');
    expect(packageFiles).not.toContain('rust/target/');
  });

  it('ships the reproducible Windows installer and pins Electron as a runtime prerequisite', () => {
    const desktop = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'desktop/package.json'), 'utf8'));
    const desktopLock = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'desktop/package-lock.json'), 'utf8'));
    const installGuide = fs.readFileSync(path.join(PROJECT_ROOT, 'docs/INSTALLATION.md'), 'utf8');
    expect(packageFiles).toContain('scripts/');
    expect(packageFiles).toContain('docs/INSTALLATION.md');
    expect(installGuide).toContain('app\\dist\\cli\\index.js');
    expect(installGuide).toContain('app\\dist\\industrial\\entrypoint.js');
    expect(installGuide).not.toContain('node_modules\\.bin\\maos');
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'scripts/New-MaosIndustrialInstallBundle.ps1'))).toBe(true);
    const installer = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts/Install-MaosIndustrial.ps1'), 'utf8');
    expect(installer).toContain("desktop/node_modules/electron/install.js");
    expect(installer).toContain('Start-Process -FilePath $node.Source');
    expect(installer).toContain('-RedirectStandardError');
    expect(desktop.dependencies.electron).toBe('45.0.0');
    expect(desktop.devDependencies.playwright).toBe('1.64.1');
    expect(desktopLock.packages[''].dependencies.electron).toBe('45.0.0');
    expect(desktopLock.packages[''].devDependencies.playwright).toBe('1.64.1');
    expect(desktopLock.packages['node_modules/electron'].version).toBe('45.0.0');
  });

  it('skips the development-only Husky hook setup when installing outside a Git checkout', () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-prepare-hook-'));
    try {
      const script = path.join(PROJECT_ROOT, 'scripts', 'prepare-hooks.js');
      const result = spawnSync(process.execPath, [script], { cwd: installRoot, encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    } finally {
      fs.rmSync(installRoot, { recursive: true, force: true });
    }
  });

  it('keeps a missing-engine run failure machine-readable and actionable', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-package-cli-'));
    try {
      const demoDir = path.join(projectRoot, 'demo', 'industrial');
      fs.mkdirSync(demoDir, { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.maos'), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, '.maos', 'maos.config.json'),
        JSON.stringify({ projectName: 'package-cli-smoke' }),
      );
      for (const name of [
        'safety_thresholds.json',
        'turbine_vibration_log.csv',
        'maintenance_report.txt',
        'turbine_inspection_scan.pdf',
      ]) {
        fs.copyFileSync(path.join(PROJECT_ROOT, 'demo', 'industrial', name), path.join(demoDir, name));
      }

      const result = spawnSync(
        process.execPath,
        [
          '-r',
          require.resolve('ts-node/register'),
          path.join(PROJECT_ROOT, 'src', 'industrial', 'entrypoint.ts'),
          'run',
          '--project-root',
          projectRoot,
          '--auto-approve',
          '--yes',
          '--json',
        ],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            TS_NODE_PROJECT: path.join(PROJECT_ROOT, 'tsconfig.json'),
            TS_NODE_TRANSPILE_ONLY: 'true',
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(false);
      expect(output.message).toContain('Engine executable not found:');
      expect(output.message).toContain('cargo build --release --locked --manifest-path rust/Cargo.toml');
      expect(output.message).toContain('copy rust/target/release/maos-engine[.exe]');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
