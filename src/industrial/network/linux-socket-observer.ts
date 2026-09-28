/**
 * F9-04: Linux Socket Observer Adapter
 *
 * Implements passive socket observation on Linux using `ss` or `/proc/net` inspection
 * and `/proc/<pid>/exe` metadata resolution.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SocketObserverAdapter, ProcessMetadata } from './socket-observer-adapter';
import { ObservedSocket, SocketState } from '../../domain/network-monitor';

const execFileAsync = promisify(execFile);

export class LinuxSocketObserver implements SocketObserverAdapter {
  public readonly platformName = 'linux';
  private readonly processCache = new Map<number, ProcessMetadata | null>();

  public async captureActiveSockets(): Promise<ObservedSocket[]> {
    const sockets: ObservedSocket[] = [];
    const timestamp = new Date().toISOString();

    try {
      // Use ss (socket statistics) with numeric hosts and process info: ss -tuanp -H
      const { stdout } = await execFileAsync('ss', ['-tuanp', '-H'], { timeout: 10000 });
      const lines = stdout.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Typical ss output format:
        // Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
        // tcp   ESTAB 0      0      127.0.0.1:3847     127.0.0.1:54321  users:(("node",pid=1234,fd=12))
        const parts = trimmed.split(/\s+/);
        if (parts.length < 5) continue;

        const protoRaw = parts[0].toLowerCase();
        const protocol = protoRaw.startsWith('tcp') ? 'tcp' : protoRaw.startsWith('udp') ? 'udp' : null;
        if (!protocol) continue;

        let state: SocketState = 'UNKNOWN';
        let localIdx = 3;
        let peerIdx = 4;
        let procIdx = 5;

        if (protocol === 'tcp') {
          const rawState = parts[1].toUpperCase();
          state = (rawState === 'ESTAB' ? 'ESTABLISHED' : rawState) as SocketState;
          localIdx = 3;
          peerIdx = 4;
          procIdx = 5;
        } else {
          // UDP often has State = UNCONN
          localIdx = 3;
          peerIdx = 4;
          procIdx = 5;
        }

        const localEndpoint = parts[localIdx] || '';
        const peerEndpoint = parts[peerIdx] || '';
        const procInfo = parts.slice(procIdx).join(' ');

        const [localAddress, localPortStr] = this.parseAddressPort(localEndpoint);
        const [remoteAddress, remotePortStr] = this.parseAddressPort(peerEndpoint);

        // Extract PID from users:(("name",pid=1234,fd=X))
        let pid = 0;
        let processName: string | undefined;
        const pidMatch = procInfo.match(/pid=(\d+)/);
        if (pidMatch) {
          pid = parseInt(pidMatch[1], 10);
        }
        const nameMatch = procInfo.match(/"([^"]+)"/);
        if (nameMatch) {
          processName = nameMatch[1];
        }

        sockets.push({
          protocol,
          localAddress: localAddress || '0.0.0.0',
          localPort: parseInt(localPortStr || '0', 10) || 0,
          remoteAddress: remoteAddress && remoteAddress !== '*' ? remoteAddress : undefined,
          remotePort: remotePortStr && remotePortStr !== '*' ? parseInt(remotePortStr, 10) : undefined,
          state,
          pid,
          processName,
          timestamp,
        });
      }
    } catch {
      // Fallback or bubble empty
      return sockets;
    }

    return sockets;
  }

  private parseAddressPort(endpoint: string): [string, string] {
    if (!endpoint || endpoint === '*') return ['', ''];

    // Handle IPv6 [::1]:port or IPv4 127.0.0.1:port
    const lastColon = endpoint.lastIndexOf(':');
    if (lastColon === -1) return [endpoint, ''];

    const addr = endpoint.slice(0, lastColon).replace(/^\[|\]$/g, '');
    const port = endpoint.slice(lastColon + 1);
    return [addr, port];
  }

  public async resolveProcessMetadata(pid: number): Promise<ProcessMetadata | null> {
    if (this.processCache.has(pid)) {
      return this.processCache.get(pid) || null;
    }

    if (pid <= 0) return null;

    try {
      const exeSymlink = `/proc/${pid}/exe`;
      if (!fs.existsSync(exeSymlink)) {
        this.processCache.set(pid, null);
        return null;
      }

      const executablePath = fs.readlinkSync(exeSymlink);
      const processName = path.basename(executablePath);

      let executableHash: string | undefined;
      try {
        const buf = fs.readFileSync(executablePath);
        executableHash = crypto.createHash('sha256').update(buf).digest('hex');
      } catch {
        // May fail if unreadable
      }

      const meta: ProcessMetadata = {
        pid,
        processName,
        executablePath,
        executableHash,
      };

      this.processCache.set(pid, meta);
      return meta;
    } catch {
      this.processCache.set(pid, null);
      return null;
    }
  }
}
