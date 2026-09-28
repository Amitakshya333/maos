/**
 * UI1-04: Project Service Host Child Process Entrypoint
 *
 * Standalone process entrypoint spawned by ProjectHostLauncher.
 * Lifecycle:
 *   1. Parse CLI arguments (--project-root, --port, --host, --allow-temp, --allow-symlinks)
 *   2. Validate project folder (fails closed if invalid)
 *   3. Instantiate and start ProjectServiceHost
 *   4. Emit structured HostReadinessEnvelope to stdout and IPC
 *   5. Listen for IPC/stdin commands (session creation, ping, shutdown)
 *   6. Cleanly handle shutdown signals (SIGTERM, SIGINT, disconnect)
 */

import * as readline from 'readline';
import * as path from 'path';
import { ProjectServiceHost } from './host';
import { assertValidProjectFolder, CanonicalProjectFolder } from './validator';
import type { SessionInfo } from './session';

export interface HostReadinessEnvelope {
  readonly type: 'service_ready';
  readonly protocolVersion: string;
  readonly serviceInstanceId: string;
  readonly pid: number;
  readonly port: number;
  readonly host: string;
  readonly projectRoot: string;
  readonly projectRootHash: string;
  readonly executablePath: string;
  readonly executableHash: string;
  readonly startedAt: string;
}

export interface HostErrorEnvelope {
  readonly type: 'service_error';
  readonly code: string;
  readonly message: string;
}

export interface HostSessionEnvelope {
  readonly type: 'session_created';
  readonly requestId: string;
  readonly session: SessionInfo;
}

export interface HostSessionErrorEnvelope {
  readonly type: 'session_error';
  readonly requestId: string;
  readonly code: string;
  readonly message: string;
}

export interface HostPongEnvelope {
  readonly type: 'pong';
  readonly requestId: string;
  readonly timestamp: number;
}

export interface HostShutdownEnvelope {
  readonly type: 'shutdown_complete';
}

export type HostOutboundEnvelope =
  | HostReadinessEnvelope
  | HostErrorEnvelope
  | HostSessionEnvelope
  | HostSessionErrorEnvelope
  | HostPongEnvelope
  | HostShutdownEnvelope;

function emitEnvelope(envelope: HostOutboundEnvelope): void {
  const line = JSON.stringify(envelope) + '\n';
  process.stdout.write(line);
  if (process.send) {
    try {
      process.send(envelope);
    } catch {
      // IPC channel may be closed
    }
  }
}

/**
 * Session responses contain bearer credentials and must never be written to
 * stdout, which may be captured by logs or inherited by an unrelated reader.
 * The launcher always provides a private Node IPC channel for this exchange.
 */
function emitPrivateEnvelope(envelope: HostOutboundEnvelope): boolean {
  if (!process.send || !process.connected) return false;
  try {
    process.send(envelope);
    return true;
  } catch {
    return false;
  }
}

interface ParsedArgs {
  projectRoot?: string;
  port?: number;
  host?: string;
  allowTemp?: boolean;
  allowSymlinks?: boolean;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project-root' && i + 1 < argv.length) {
      result.projectRoot = argv[++i];
    } else if (arg === '--port' && i + 1 < argv.length) {
      result.port = parseInt(argv[++i], 10);
    } else if (arg === '--host' && i + 1 < argv.length) {
      result.host = argv[++i];
    } else if (arg === '--allow-temp') {
      result.allowTemp = true;
    } else if (arg === '--allow-symlinks') {
      result.allowSymlinks = true;
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);

  if (!args.projectRoot) {
    emitEnvelope({
      type: 'service_error',
      code: 'MISSING_PROJECT_ROOT_ARG',
      message: 'Missing required CLI argument: --project-root <path>',
    });
    process.exit(1);
  }

  // 1. Validate project folder before touching any network interface
  let project: CanonicalProjectFolder;
  try {
    project = assertValidProjectFolder(args.projectRoot, {
      allowTemp: args.allowTemp,
      allowSymlinks: args.allowSymlinks,
    });
  } catch (err: any) {
    emitEnvelope({
      type: 'service_error',
      code: err.code || 'PROJECT_VALIDATION_FAILED',
      message: err.message || String(err),
    });
    process.exit(1);
  }

  // 2. Instantiate and start ProjectServiceHost
  const bindHost = args.host || '127.0.0.1';
  const bindPort = args.port ?? 0;

  const serviceHost = new ProjectServiceHost(project.canonicalPath, {
    host: bindHost,
    port: bindPort,
  });

  let isStopping = false;

  const gracefulStop = async (code = 0) => {
    if (isStopping) return;
    isStopping = true;
    try {
      await serviceHost.stop();
    } catch {
      // Ignore errors on shutdown
    }
    process.exit(code);
  };

  process.once('SIGTERM', () => gracefulStop(0));
  process.once('SIGINT', () => gracefulStop(0));
  process.once('disconnect', () => gracefulStop(0));

  process.on('uncaughtException', async (err) => {
    emitEnvelope({
      type: 'service_error',
      code: 'UNCAUGHT_EXCEPTION',
      message: err.message || String(err),
    });
    await gracefulStop(1);
  });

  process.on('unhandledRejection', async (reason) => {
    emitEnvelope({
      type: 'service_error',
      code: 'UNHANDLED_REJECTION',
      message: String(reason),
    });
    await gracefulStop(1);
  });

  try {
    const { port, identity } = await serviceHost.start(bindPort);

    // 3. Emit structured readiness envelope
    const readiness: HostReadinessEnvelope = {
      type: 'service_ready',
      protocolVersion: identity.protocolVersion,
      serviceInstanceId: identity.serviceInstanceId,
      pid: process.pid,
      port,
      host: identity.host,
      projectRoot: identity.projectRoot,
      projectRootHash: identity.projectRootHash,
      executablePath: identity.executablePath,
      executableHash: identity.executableHash,
      startedAt: identity.startedAt,
    };

    emitEnvelope(readiness);

    // 4. Listen for commands from parent via IPC and stdin
    const handleCommand = async (cmd: any) => {
      if (!cmd || typeof cmd !== 'object') return;

      if (cmd.type === 'create_session') {
        try {
          const session = serviceHost.createSession(cmd.windowId);
          const sent = emitPrivateEnvelope({
            type: 'session_created',
            requestId: cmd.requestId,
            session,
          });
          if (!sent) {
            serviceHost.getSessionManager().revokeSession(session.sessionId);
            throw new Error('SESSION_CHANNEL_UNAVAILABLE: Session credentials require private launcher IPC.');
          }
        } catch (err: any) {
          emitPrivateEnvelope({
            type: 'session_error',
            requestId: cmd.requestId,
            code: err.code || 'SESSION_CREATION_FAILED',
            message: err.message || String(err),
          });
        }
      } else if (cmd.type === 'ping') {
        emitEnvelope({
          type: 'pong',
          requestId: cmd.requestId,
          timestamp: Date.now(),
        });
      } else if (cmd.type === 'shutdown') {
        emitEnvelope({
          type: 'shutdown_complete',
        });
        await gracefulStop(0);
      }
    };

    if (process.on) {
      process.on('message', (msg: any) => {
        handleCommand(msg);
      });
    }

    if (process.stdin) {
      const rl = readline.createInterface({
        input: process.stdin,
        terminal: false,
      });

      rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const cmd = JSON.parse(trimmed);
          handleCommand(cmd);
        } catch {
          // Ignore unparseable stdin lines
        }
      });
    }
  } catch (err: any) {
    emitEnvelope({
      type: 'service_error',
      code: err.code || 'HOST_START_FAILED',
      message: err.message || String(err),
    });
    await gracefulStop(1);
  }
}

// Only execute main if invoked directly as CLI script
if (require.main === module) {
  main().catch(async (err) => {
    emitEnvelope({
      type: 'service_error',
      code: 'FATAL_ENTRYPOINT_ERROR',
      message: err.message || String(err),
    });
    process.exit(1);
  });
}
