import * as path from 'path';
import * as fs from 'fs';

/**
 * All MAOS runtime data lives under .maos/ in the project root.
 * This module resolves paths relative to that directory.
 */

export function getMaosRoot(cwd: string = process.cwd()): string {
  return path.join(cwd, '.maos');
}

export function getConfigPath(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'maos.config.json');
}

export function getQueueDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'queue');
}

export function getPendingDir(cwd?: string): string {
  return path.join(getQueueDir(cwd), 'pending');
}

export function getActiveDir(cwd?: string): string {
  return path.join(getQueueDir(cwd), 'active');
}

export function getDoneDir(cwd?: string): string {
  return path.join(getQueueDir(cwd), 'done');
}

export function getStatusDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'status');
}

export function getLogsDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'logs');
}

export function getPoolPath(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'pool.json');
}

export function getBrainDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'brain');
}

export function getTelemetryDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'telemetry');
}

export function getCheckpointsDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'checkpoints');
}

export function getRetryDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'queue', 'retry');
}

export function getFailedDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'queue', 'failed');
}

export function getEventsDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'events');
}

export function getMemoryDir(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'memory');
}

export function getObjectivesDir(cwd?: string): string {
  return path.join(getQueueDir(cwd), 'objectives');
}

export function getCancelledDir(cwd?: string): string {
  return path.join(getQueueDir(cwd), 'cancelled');
}

export function getCredentialsPath(cwd?: string): string {
  return path.join(getMaosRoot(cwd), 'credentials.json');
}

/**
 * Ensure all required .maos/ subdirectories exist.
 */
export function ensureMaosDirectories(cwd?: string): void {
  const dirs = [
    getMaosRoot(cwd),
    getQueueDir(cwd),
    getPendingDir(cwd),
    getActiveDir(cwd),
    getDoneDir(cwd),
    getStatusDir(cwd),
    getLogsDir(cwd),
    getBrainDir(cwd),
    getTelemetryDir(cwd),
    getCheckpointsDir(cwd),
    getRetryDir(cwd),
    getFailedDir(cwd),
    getEventsDir(cwd),
    getMemoryDir(cwd),
    getObjectivesDir(cwd),
    getCancelledDir(cwd),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  try {
    hardenGitignore(cwd);
  } catch {
    // Ignore gitignore errors to avoid breaking startup
  }
}

/**
 * Hardens the .gitignore file by ensuring critical MAOS files/directories are ignored.
 */
export function hardenGitignore(cwd?: string): void {
  const targetCwd = cwd || process.cwd();
  const gitignorePath = path.join(targetCwd, '.gitignore');
  const requiredIgnores = [
    '.maos/auth/',
    '.maos/checkpoints/',
    '.maos/events/',
    '.maos/telemetry/',
    '.maos/memory/',
    '.maos/queue/',
    '.maos/logs/',
    '.maos/brain/',
    '.maos/status/',
    '.maos/credentials.json',
    '*.db',
    '*.db-shm',
    '*.db-wal',
    '*.sqlite',
    '*.sqlite-shm',
    '*.sqlite-wal',
    '.env',
  ];

  let currentContent = '';
  if (fs.existsSync(gitignorePath)) {
    try {
      currentContent = fs.readFileSync(gitignorePath, 'utf-8');
    } catch {
      // Ignore reading error, treat as empty
    }
  }

  // Parse lines, normalize slash direction/trail
  const lines = currentContent.split(/\r?\n/).map((line) => line.trim());
  const toAppend: string[] = [];

  for (const item of requiredIgnores) {
    const normalizedItem = item.replace(/\\/g, '/');
    if (
      !lines.some((l) => {
        const normalizedL = l.trim().replace(/\\/g, '/');
        return (
          normalizedL === normalizedItem ||
          normalizedL === normalizedItem.replace(/\/$/, '') ||
          (normalizedItem.endsWith('/') && normalizedL === '/' + normalizedItem)
        );
      })
    ) {
      toAppend.push(item);
    }
  }

  if (toAppend.length > 0) {
    const divider = currentContent && !currentContent.endsWith('\n') ? '\n' : '';
    const header = currentContent.includes('# MAOS Runtime Internals') ? '' : '\n# MAOS Runtime Internals\n';
    fs.appendFileSync(gitignorePath, divider + header + toAppend.join('\n') + '\n', 'utf-8');
  }
}

/**
 * Check if current directory has been initialized with `maos init`.
 */
export function isMaosInitialized(cwd?: string): boolean {
  return fs.existsSync(getConfigPath(cwd));
}
