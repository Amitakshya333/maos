/**
 * F9-04: Socket Observer Adapter Interface
 *
 * Defines the contract for platform-specific passive network socket inspection
 * and process metadata resolution.
 */

import { ObservedSocket } from '../../domain/network-monitor';

export interface ProcessMetadata {
  readonly pid: number;
  readonly processName?: string;
  readonly executablePath?: string;
  readonly executableHash?: string;
}

export interface SocketObserverAdapter {
  readonly platformName: string;

  /**
   * Captures the current snapshot of active TCP and UDP sockets across the host.
   */
  captureActiveSockets(): Promise<ObservedSocket[]>;

  /**
   * Resolves detailed process metadata (name, path, executable hash) for a given PID.
   */
  resolveProcessMetadata(pid: number): Promise<ProcessMetadata | null>;
}
