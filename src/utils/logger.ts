import * as fs from 'fs';
import * as path from 'path';
import { getLogsDir } from './paths';
import chalk from 'chalk';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  SUCCESS = 'SUCCESS',
}

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  [LogLevel.DEBUG]: chalk.gray,
  [LogLevel.INFO]: chalk.cyan,
  [LogLevel.WARN]: chalk.yellow,
  [LogLevel.ERROR]: chalk.red,
  [LogLevel.SUCCESS]: chalk.green,
};

const LEVEL_ICONS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '🔍',
  [LogLevel.INFO]: '📋',
  [LogLevel.WARN]: '⚠️',
  [LogLevel.ERROR]: '❌',
  [LogLevel.SUCCESS]: '✅',
};

/**
 * Structured logger for MAOS.
 * Writes to both console (colored) and .maos/logs/orchestrator.log (plain).
 */
export class Logger {
  private logFile: string | null = null;

  constructor(logDir?: string) {
    if (logDir && fs.existsSync(logDir)) {
      this.logFile = path.join(logDir, 'orchestrator.log');
    }
  }

  private format(level: LogLevel, component: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] [${component}] ${message}`;
  }

  /** Max log file size before rotation (10MB) */
  private static readonly MAX_LOG_SIZE = 10 * 1024 * 1024;
  /** Number of rotated log files to keep */
  private static readonly MAX_ROTATED_FILES = 3;

  private log(level: LogLevel, component: string, message: string): void {
    const formatted = this.format(level, component, message);
    const color = LEVEL_COLORS[level];
    const icon = LEVEL_ICONS[level];

    // Console output (colored)
    console.log(`${icon} ${color(formatted)}`);

    // File output (plain) with rotation
    if (this.logFile) {
      try {
        this.rotateIfNeeded();
        fs.appendFileSync(this.logFile, formatted + '\n');
      } catch {
        // Don't crash if log write fails
      }
    }
  }

  /**
   * Rotate log file if it exceeds MAX_LOG_SIZE.
   * Keeps up to MAX_ROTATED_FILES rotated copies.
   * orchestrator.log → orchestrator.1.log → orchestrator.2.log → orchestrator.3.log (deleted)
   */
  private rotateIfNeeded(): void {
    if (!this.logFile) return;
    try {
      if (!fs.existsSync(this.logFile)) return;
      const stat = fs.statSync(this.logFile);
      if (stat.size < Logger.MAX_LOG_SIZE) return;

      // Shift rotated files: .3 → delete, .2 → .3, .1 → .2
      for (let i = Logger.MAX_ROTATED_FILES; i >= 1; i--) {
        const from: string = i === 1 ? this.logFile : `${this.logFile}.${i - 1}`;
        const to = `${this.logFile}.${i}`;
        if (i === Logger.MAX_ROTATED_FILES && fs.existsSync(to)) {
          fs.unlinkSync(to);
        }
        if (fs.existsSync(from) && from !== this.logFile) {
          fs.renameSync(from, to);
        }
      }
      // Rotate current → .1
      fs.renameSync(this.logFile, `${this.logFile}.1`);
    } catch {
      /* non-fatal */
    }
  }

  debug(component: string, message: string): void {
    this.log(LogLevel.DEBUG, component, message);
  }

  info(component: string, message: string): void {
    this.log(LogLevel.INFO, component, message);
  }

  warn(component: string, message: string): void {
    this.log(LogLevel.WARN, component, message);
  }

  error(component: string, message: string): void {
    this.log(LogLevel.ERROR, component, message);
  }

  success(component: string, message: string): void {
    this.log(LogLevel.SUCCESS, component, message);
  }
}

/**
 * Create a logger instance for the current project.
 * Falls back to console-only if .maos/ doesn't exist yet.
 */
export function createLogger(cwd?: string): Logger {
  try {
    const logDir = getLogsDir(cwd);
    return new Logger(logDir);
  } catch {
    return new Logger();
  }
}
