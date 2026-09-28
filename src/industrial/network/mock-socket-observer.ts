/**
 * F9-04: Mock Socket Observer Adapter
 *
 * Controllable in-memory adapter for unit testing, integration tests,
 * fault injection, and synthetic network violation testing without host side-effects.
 */

import { SocketObserverAdapter, ProcessMetadata } from './socket-observer-adapter';
import { ObservedSocket, NetworkMonitorError, NETWORK_MONITOR_ERROR_CODES } from '../../domain/network-monitor';

export interface MockSocketObserverOptions {
  readonly initialSockets?: readonly ObservedSocket[];
  readonly processes?: readonly ProcessMetadata[];
  readonly failCapture?: boolean;
  readonly failProcessResolution?: boolean;
  readonly captureDelayMs?: number;
}

export class MockSocketObserver implements SocketObserverAdapter {
  public readonly platformName = 'mock';

  private sockets: ObservedSocket[] = [];
  private processes = new Map<number, ProcessMetadata>();

  public failCapture: boolean = false;
  public failProcessResolution: boolean = false;
  public captureDelayMs: number = 0;
  public captureCalls: number = 0;
  public lastCapturedAt?: string;

  constructor(options: MockSocketObserverOptions = {}) {
    if (options.initialSockets) {
      this.sockets = [...options.initialSockets];
    }
    if (options.processes) {
      for (const p of options.processes) {
        this.processes.set(p.pid, p);
      }
    }
    this.failCapture = options.failCapture ?? false;
    this.failProcessResolution = options.failProcessResolution ?? false;
    this.captureDelayMs = options.captureDelayMs ?? 0;
  }

  public async captureActiveSockets(): Promise<ObservedSocket[]> {
    this.captureCalls++;
    this.lastCapturedAt = new Date().toISOString();

    if (this.captureDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.captureDelayMs));
    }

    if (this.failCapture) {
      throw new NetworkMonitorError(
        NETWORK_MONITOR_ERROR_CODES.OBSERVER_ADAPTER_ERROR,
        'Simulated socket capture failure in mock adapter',
      );
    }

    // Return copy of current sockets, auto-populating processName if known and not already set
    return this.sockets.map((s) => {
      const proc = this.processes.get(s.pid);
      return {
        ...s,
        processName: s.processName || proc?.processName,
        executablePath: s.executablePath || proc?.executablePath,
        executableHash: s.executableHash || proc?.executableHash,
        timestamp: s.timestamp || this.lastCapturedAt!,
      };
    });
  }

  public async resolveProcessMetadata(pid: number): Promise<ProcessMetadata | null> {
    if (this.failProcessResolution) {
      throw new NetworkMonitorError(
        NETWORK_MONITOR_ERROR_CODES.PROCESS_RESOLUTION_FAILED,
        `Simulated process resolution failure for PID ${pid}`,
      );
    }

    return this.processes.get(pid) || null;
  }

  public setMockSockets(sockets: readonly ObservedSocket[]): void {
    this.sockets = [...sockets];
  }

  public addMockSocket(socket: ObservedSocket): void {
    this.sockets.push(socket);
  }

  public clearMockSockets(): void {
    this.sockets = [];
  }

  public setMockProcess(metadata: ProcessMetadata): void {
    this.processes.set(metadata.pid, metadata);
  }

  public clearMockProcesses(): void {
    this.processes.clear();
  }
}
