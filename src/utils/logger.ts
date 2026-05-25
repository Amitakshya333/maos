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

  private log(level: LogLevel, component: string, message: string): void {
    const formatted = this.format(level, component, message);
    const color = LEVEL_COLORS[level];
    const icon = LEVEL_ICONS[level];

    // Console output (colored)
    console.log(`${icon} ${color(formatted)}`);

    // File output (plain)
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, formatted + '\n');
      } catch {
        // Don't crash if log write fails
      }
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
