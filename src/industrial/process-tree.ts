/**
 * F9-10: Process Tree Resolution
 *
 * Resolves a process and its descendants so the process-scoped boundary can
 * attribute observed sockets to the MAOS process tree instead of the whole
 * machine. Attribution scope is what makes the boundary's claim precise: a
 * monitor with no PID filter evaluates *every* socket on the host, which would
 * report a violation for any unrelated connection (a browser, Windows Update)
 * and make the boundary both unfalsifiable and permanently blocked.
 *
 * Resolution is best-effort and read-only. It never requires elevation, and it
 * never mutates process state. On failure the caller receives the root PID
 * alone — a narrower but still truthful attribution scope.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Maximum depth walked when resolving descendants (guards against PID cycles). */
const MAX_DEPTH = 32;

interface ProcessNode {
  readonly pid: number;
  readonly ppid: number;
}

async function listProcessNodes(): Promise<ProcessNode[] | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
        ],
        { timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      );

      const trimmed = stdout.trim();
      if (!trimmed) return [];

      const parsed = JSON.parse(trimmed);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .filter((r: any) => r && r.ProcessId !== undefined)
        .map((r: any) => ({
          pid: Number(r.ProcessId),
          ppid: Number(r.ParentProcessId ?? 0),
        }))
        .filter((n: ProcessNode) => Number.isFinite(n.pid) && n.pid > 0);
    }

    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='], {
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    });

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .map((parts) => ({ pid: Number(parts[0]), ppid: Number(parts[1]) }))
      .filter((n) => Number.isFinite(n.pid) && Number.isFinite(n.ppid) && n.pid > 0);
  } catch {
    return null;
  }
}

export interface ProcessTreeResolution {
  /** The resolved attribution scope, always contains `rootPid`. */
  readonly pids: readonly number[];
  /** True when descendants were resolved from the OS; false when degraded. */
  readonly complete: boolean;
  readonly reason?: string;
}

/**
 * Resolves `rootPid` and all of its descendants.
 *
 * Degrades to `[rootPid]` (never to an empty set, and never to "all sockets")
 * when the OS process list cannot be read, so the resulting attribution scope is
 * always a strict subset of the host.
 */
export async function resolveProcessTree(
  rootPid: number,
): Promise<ProcessTreeResolution> {
  if (!Number.isFinite(rootPid) || rootPid <= 0) {
    return {
      pids: [],
      complete: false,
      reason: `Invalid root PID: ${rootPid}.`,
    };
  }

  const nodes = await listProcessNodes();
  if (nodes === null) {
    return {
      pids: [rootPid],
      complete: false,
      reason:
        'OS process list unavailable; attribution scope degraded to the root process only.',
    };
  }

  const childrenByParent = new Map<number, number[]>();
  for (const node of nodes) {
    const list = childrenByParent.get(node.ppid);
    if (list) list.push(node.pid);
    else childrenByParent.set(node.ppid, [node.pid]);
  }

  const pids: number[] = [];
  const seen = new Set<number>();
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];

  while (queue.length > 0) {
    const { pid, depth } = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);

    if (depth >= MAX_DEPTH) continue;
    for (const child of childrenByParent.get(pid) || []) {
      if (!seen.has(child)) queue.push({ pid: child, depth: depth + 1 });
    }
  }

  return { pids, complete: true };
}

/**
 * Merges explicit PIDs with a resolved process tree, de-duplicated and sorted.
 */
export function mergeProcessScope(
  extraPids: readonly number[],
  tree: readonly number[],
): number[] {
  const merged = new Set<number>();
  for (const pid of tree) merged.add(pid);
  for (const pid of extraPids) {
    if (Number.isFinite(pid) && pid > 0) merged.add(pid);
  }
  return Array.from(merged).sort((a, b) => a - b);
}
