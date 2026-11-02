import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import chalk from 'chalk';
import {
  decideAndResumeJudgedRunAfterApproval,
  isAcceptedJudgedRun,
  prepareAgentJudgedRun,
  readJudgedRunManifest,
} from './judged-run';
import { createServiceContainer } from '../service';

export interface IndustrialReplOptions {
  projectRoot?: string;
  input?: Readable;
  output?: Writable;
}

function write(output: Writable, value: string): void {
  output.write(`${value}\n`);
}

export function safeTerminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error('Run ID must contain only letters, numbers, dots, underscores, or hyphens.');
  }
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote = '';

  for (const character of line.trim()) {
    if (quote) {
      if (character === quote) quote = '';
      else token += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = '';
    } else {
      token += character;
    }
  }

  if (quote) throw new Error('Close the quoted value and retry.');
  if (token) tokens.push(token);
  return tokens;
}

function showHelp(output: Writable, projectRoot: string): void {
  write(output, [
    'MAOS Industrial local operator commands:',
    '  project [directory]                 Show or select a project root',
    '  analyze <relative.csv> <request>    Analyze the selected project CSV',
    '  status <run-id>                     Show persisted run and current acceptance',
    '  approve <run-id> <reviewer> [note]  Approve and finalize the prepared DOCX',
    '  reject <run-id> <reviewer> [note]   Reject the prepared report',
    '  report <run-id>                     Show the accepted report path and hash',
    '  verify <run-id>                     Verify audit and current report acceptance',
    '  cancel                              Cancel an analysis currently in progress',
    '  help, exit',
    '',
    'Only these commands are accepted; input is never passed to a shell.',
    'Initialize with `maos init`, choose a local provider, then configure ANALYST_AGENT',
    'with a credential-free loopback endpoint. Analysis fails closed without it.',
    `Active project: ${safeTerminalText(projectRoot)}`,
  ].join('\n'));
}

async function execute(
  tokens: string[],
  context: { projectRoot: string; output: Writable; controller?: AbortController },
): Promise<'continue' | 'exit'> {
  const [command, ...args] = tokens;
  const { output } = context;

  if (command === 'help' || command === '?') {
    showHelp(output, context.projectRoot);
  } else if (command === 'exit' || command === 'quit') {
    return 'exit';
  } else if (command === 'project') {
    if (args.length > 1) throw new Error('Usage: project [directory]');
    if (args.length === 0) {
      write(output, `Active project: ${safeTerminalText(context.projectRoot)}`);
    } else {
      const selected = fs.realpathSync(path.resolve(context.projectRoot, args[0]));
      if (!fs.statSync(selected).isDirectory()) throw new Error('Project path must be a directory.');
      context.projectRoot = selected;
      write(output, `Active project: ${safeTerminalText(context.projectRoot)}`);
    }
  } else if (command === 'analyze') {
    if (args.length < 2) throw new Error('Usage: analyze <relative.csv> <request>');
    const [sourcePath, ...requestParts] = args;
    const controller = new AbortController();
    context.controller = controller;
    const services = createServiceContainer(context.projectRoot);
    try {
      const result = await services.industrialAnalysisAgent.analyze(context.projectRoot, {
        sourcePath,
        request: requestParts.join(' '),
      }, { signal: controller.signal });
      const judgedRun = prepareAgentJudgedRun(context.projectRoot, services, result.evidence.analysisId);
      const numeric = result.evidence.result;
      write(output, [
        `Analysis provider: ${safeTerminalText(result.provider)}`,
        `Requested model: ${safeTerminalText(result.requestedModel)}`,
        `Provider-reported model: ${safeTerminalText(result.reportedModel || 'unavailable')}`,
        `Selected source: ${safeTerminalText(result.evidence.source.selectedPath)} (${result.evidence.source.sha256})`,
        `Replay-verified numeric findings: ${JSON.stringify(numeric)}`,
        `Receipt: ${safeTerminalText(result.evidence.analysisId)} (${result.evidence.receiptSha256})`,
        `Engineering verdict: ${safeTerminalText(numeric.verdict ?? 'unavailable')}`,
        `Model-generated explanation — UNVERIFIED: ${safeTerminalText(result.explanation)}`,
        `Review run: ${judgedRun.runId} (${judgedRun.status}); approval ${judgedRun.approvalId}`,
      ].join('\n'));
    } finally {
      context.controller = undefined;
    }
  } else if (command === 'cancel') {
    if (args.length) throw new Error('Usage: cancel');
    if (!context.controller) write(output, 'No cancellable analysis is currently running.');
    else {
      context.controller.abort();
      write(output, 'Cancellation requested; the analysis will remain unaccepted.');
    }
  } else if (command === 'status' || command === 'report' || command === 'verify') {
    if (args.length !== 1) throw new Error(`Usage: ${command} <run-id>`);
    validateRunId(args[0]);
    const services = createServiceContainer(context.projectRoot);
    const manifest = readJudgedRunManifest(context.projectRoot, args[0]);
    if (!manifest) throw new Error(`Run '${safeTerminalText(args[0])}' was not found in the active project.`);
    const accepted = isAcceptedJudgedRun(context.projectRoot, services, manifest);

    if (command === 'status') {
      write(output, [
        `Run: ${manifest.runId}`,
        `Persisted status: ${manifest.status}`,
        `Current accepted deliverable: ${accepted ? 'yes' : 'no'}`,
        `Engineering verdict: ${manifest.verdict}`,
        `Approval: ${manifest.approvalId}`,
        ...(manifest.failureReason ? [`Failure: ${safeTerminalText(manifest.failureReason)}`] : []),
      ].join('\n'));
    } else if (command === 'report') {
      if (!accepted || !manifest.deliverablePath || !manifest.deliverableSha256) {
        throw new Error(`Run '${manifest.runId}' has no currently accepted report.`);
      }
      write(output, `Accepted report: ${path.resolve(context.projectRoot, manifest.deliverablePath)}\nSHA-256: ${manifest.deliverableSha256}`);
    } else {
      const audit = services.audit.verifyChain();
      const valid = audit.valid && accepted;
      write(output, `Audit chain: ${audit.valid ? 'valid' : 'invalid'}\nCurrent report acceptance: ${accepted ? 'valid' : 'unavailable'}\nVerification: ${valid ? 'VERIFIED' : 'FAILED'}`);
      if (audit.errors.length) write(output, audit.errors.map(safeTerminalText).join('\n'));
      if (!valid) throw new Error('The run is not currently accepted or the audit chain is invalid.');
    }
  } else if (command === 'approve' || command === 'reject') {
    if (args.length < 2) throw new Error(`Usage: ${command} <run-id> <reviewer> [note]`);
    const [runId, reviewer, ...noteParts] = args;
    validateRunId(runId);
    const services = createServiceContainer(context.projectRoot);
    const manifest = readJudgedRunManifest(context.projectRoot, runId);
    if (!manifest) throw new Error(`Run '${safeTerminalText(runId)}' was not found in the active project.`);
    const result = await decideAndResumeJudgedRunAfterApproval(
      context.projectRoot,
      services,
      manifest.approvalId,
      {
        decision: command === 'approve' ? 'approved' : 'rejected',
        actorId: reviewer,
        actorRole: 'engineer',
        notes: noteParts.join(' ') || undefined,
      },
    );
    const accepted = isAcceptedJudgedRun(context.projectRoot, services, result.judgedRun);
    write(output, [
      `Approval ${result.approval.status}: ${result.approval.approvalId}`,
      'Local CLI reviewer identity is operator-supplied and is not independently authenticated.',
      `Run status: ${result.judgedRun.status}`,
      `Current accepted deliverable: ${accepted ? 'yes' : 'no'}`,
      `Engineering verdict: ${result.judgedRun.verdict}`,
      ...(accepted && result.judgedRun.deliverablePath ? [`Report: ${path.resolve(context.projectRoot, result.judgedRun.deliverablePath)}`] : []),
    ].join('\n'));
  } else {
    throw new Error(`Unknown command '${safeTerminalText(command)}'. Type 'help' for supported commands.`);
  }

  return 'continue';
}

export function runIndustrialRepl(options: IndustrialReplOptions = {}): Promise<void> {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const context: { projectRoot: string; output: Writable; controller?: AbortController } = {
    projectRoot: fs.realpathSync(path.resolve(options.projectRoot || process.cwd())),
    output,
  };
  const rl = readline.createInterface({ input, output, terminal: Boolean((output as Writable & { isTTY?: boolean }).isTTY) });

  return new Promise((resolve) => {
    let busy = false;
    let closing = false;
    rl.setPrompt('maos-industrial> ');
    write(output, 'MAOS Industrial local operator. Type `help` for commands.');
    rl.prompt();

    rl.on('line', (line) => {
      let tokens: string[];
      try {
        tokens = tokenize(line);
      } catch (error) {
        write(output, chalk.red(safeTerminalText(error instanceof Error ? error.message : error)));
        rl.prompt();
        return;
      }
      if (tokens.length === 0) {
        rl.prompt();
        return;
      }
      if (busy) {
        if (tokens[0] === 'cancel' && context.controller) void execute(tokens, context).catch(() => undefined);
        else write(output, 'An operation is in progress. Enter `cancel` to stop analysis or wait for it to finish.');
        return;
      }

      busy = true;
      void execute(tokens, context)
        .then((result) => {
          if (result === 'exit') {
            closing = true;
            rl.close();
          }
        })
        .catch((error) => {
          const code = typeof error?.code === 'string' ? ` [${safeTerminalText(error.code)}]` : '';
          write(output, chalk.red(`Error${code}: ${safeTerminalText(error instanceof Error ? error.message : error)}`));
        })
        .finally(() => {
          busy = false;
          if (!closing) rl.prompt();
        });
      if (context.controller) rl.prompt();
    });

    rl.on('SIGINT', () => {
      if (context.controller) context.controller.abort();
      else rl.close();
    });

    rl.on('close', () => {
      if (context.controller) context.controller.abort();
      resolve();
    });
  });
}
