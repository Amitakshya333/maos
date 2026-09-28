/**
 * F9-04: Windows Socket Observer Adapter
 *
 * Implements passive socket observation on Windows using PowerShell NetSecurity
 * cmdlets (Get-NetTCPConnection, Get-NetUDPEndpoint) and process metadata resolution.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { SocketObserverAdapter, ProcessMetadata } from './socket-observer-adapter';
import { ObservedSocket, SocketState } from '../../domain/network-monitor';

const execFileAsync = promisify(execFile);

const TCP_STATE_MAP: Record<number | string, SocketState> = {
  1: 'CLOSE',
  2: 'LISTEN',
  3: 'SYN_SENT',
  4: 'SYN_RECV',
  5: 'ESTABLISHED',
  6: 'FIN_WAIT1',
  7: 'FIN_WAIT2',
  8: 'CLOSE_WAIT',
  9: 'CLOSING',
  10: 'LAST_ACK',
  11: 'TIME_WAIT',
  12: 'CLOSE',
  Listen: 'LISTEN',
  Established: 'ESTABLISHED',
  SynSent: 'SYN_SENT',
  SynReceived: 'SYN_RECV',
  FinWait1: 'FIN_WAIT1',
  FinWait2: 'FIN_WAIT2',
  CloseWait: 'CLOSE_WAIT',
  Closing: 'CLOSING',
  LastAck: 'LAST_ACK',
  TimeWait: 'TIME_WAIT',
  Bound: 'LISTEN',
  Closed: 'CLOSE',
};

export class WindowsSocketObserver implements SocketObserverAdapter {
  public readonly platformName = 'windows';
  private readonly processCache = new Map<number, ProcessMetadata | null>();

  public async captureActiveSockets(): Promise<ObservedSocket[]> {
    const sockets: ObservedSocket[] = [];
    const timestamp = new Date().toISOString();

    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$tcp = @(Get-NetTCPConnection | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess)
$udp = @(Get-NetUDPEndpoint | Select-Object LocalAddress,LocalPort,OwningProcess)
[PSCustomObject]@{
  tcp = $tcp
  udp = $udp
} | ConvertTo-Json -Depth 3 -Compress
`;

    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
      );

      const parsed = JSON.parse(stdout.trim());

      // Parse TCP
      const tcpList = Array.isArray(parsed.tcp) ? parsed.tcp : parsed.tcp ? [parsed.tcp] : [];
      for (const item of tcpList) {
        if (!item || item.OwningProcess === undefined) continue;
        const pid = Number(item.OwningProcess);
        const stateKey = item.State;
        const mappedState: SocketState = TCP_STATE_MAP[stateKey] || 'UNKNOWN';

        sockets.push({
          protocol: 'tcp',
          localAddress: String(item.LocalAddress || '0.0.0.0'),
          localPort: Number(item.LocalPort || 0),
          remoteAddress: item.RemoteAddress ? String(item.RemoteAddress) : undefined,
          remotePort: item.RemotePort ? Number(item.RemotePort) : undefined,
          state: mappedState,
          pid,
          timestamp,
        });
      }

      // Parse UDP
      const udpList = Array.isArray(parsed.udp) ? parsed.udp : parsed.udp ? [parsed.udp] : [];
      for (const item of udpList) {
        if (!item || item.OwningProcess === undefined) continue;
        const pid = Number(item.OwningProcess);

        sockets.push({
          protocol: 'udp',
          localAddress: String(item.LocalAddress || '0.0.0.0'),
          localPort: Number(item.LocalPort || 0),
          pid,
          timestamp,
        });
      }
    } catch (err) {
      // Fallback or bubble up as empty array if powershell execution fails
      return sockets;
    }

    return sockets;
  }

  public async resolveProcessMetadata(pid: number): Promise<ProcessMetadata | null> {
    if (this.processCache.has(pid)) {
      return this.processCache.get(pid) || null;
    }

    if (pid <= 4) {
      const meta: ProcessMetadata = {
        pid,
        processName: pid === 0 ? 'Idle' : 'System',
      };
      this.processCache.set(pid, meta);
      return meta;
    }

    try {
      const script = `
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($p) {
  [PSCustomObject]@{
    Id = $p.Id
    ProcessName = $p.ProcessName
    Path = $p.Path
  } | ConvertTo-Json -Compress
}
`;
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 5000 },
      );

      const trimmed = stdout.trim();
      if (!trimmed) {
        this.processCache.set(pid, null);
        return null;
      }

      const parsed = JSON.parse(trimmed);
      let executableHash: string | undefined;

      if (parsed.Path && fs.existsSync(parsed.Path)) {
        try {
          const buf = fs.readFileSync(parsed.Path);
          executableHash = crypto.createHash('sha256').update(buf).digest('hex');
        } catch {
          // May fail if access is restricted
        }
      }

      const meta: ProcessMetadata = {
        pid,
        processName: parsed.ProcessName ? `${parsed.ProcessName}.exe` : undefined,
        executablePath: parsed.Path || undefined,
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
