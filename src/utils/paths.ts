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
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Check if current directory has been initialized with `maos init`.
 */
export function isMaosInitialized(cwd?: string): boolean {
  return fs.existsSync(getConfigPath(cwd));
}
