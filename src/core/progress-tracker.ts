/**
 * Semantic Progress Tracker
 *
 * Tracks whether the agent is making genuine progress vs spinning in place.
 *
 * Progress is detected when the agent:
 *   - Reads a file it has never read before
 *   - Lists a directory it has never listed before
 *   - Runs a search query it has never run before
 *   - Uses a write/exec/commit tool (always productive)
 *   - Calls a diverse mix of tool types
 *
 * Idle is ONLY counted when:
 *   - Repeated identical reads (same path, same content)
 *   - Repeated identical searches (same query)
 *   - No new files/directories discovered
 *   - No tool diversity (same tool called repeatedly)
 *   - No state progression whatsoever
 */
export class ProgressTracker {
  private seenFiles = new Set<string>(); // Files already read
  private seenDirs = new Set<string>(); // Dirs already listed
  private seenSearches = new Set<string>(); // Search queries already run
  private commandRunCounts = new Map<string, number>(); // Command execution frequency
  private seenWrites = new Set<string>(); // Write path + excerpt signature
  private toolCallsThisIteration = new Set<string>(); // Tool types this iteration
  private lastIterationTools: string[] = []; // Tool names from last iteration

  idleCount = 0;
  private readonly MAX_IDLE = 6;
  private readonly MAX_COMMAND_REPEATS = 3;

  /**
   * Record all tool calls from one iteration and return whether this
   * iteration was productive (true) or idle (false).
   */
  recordIteration(toolCalls: Array<{ name: string; args: Record<string, any> }>): boolean {
    this.toolCallsThisIteration.clear();
    let newContextDiscovered = false;
    let hasMutatingCall = false;
    const thisIterToolNames: string[] = [];

    for (const { name, args } of toolCalls) {
      this.toolCallsThisIteration.add(name);
      thisIterToolNames.push(name);

      switch (name) {
        case 'read_file': {
          const p = (args.path || '').toLowerCase().trim();
          if (p && !this.seenFiles.has(p)) {
            this.seenFiles.add(p);
            newContextDiscovered = true; // New file = new context
          }
          break;
        }
        case 'list_dir': {
          const d = (args.path || '.').toLowerCase().trim();
          if (!this.seenDirs.has(d)) {
            this.seenDirs.add(d);
            newContextDiscovered = true; // New directory = new context
          }
          break;
        }
        case 'search_code': {
          // Normalize query for dedup
          const q = (args.query || '').toLowerCase().trim().substring(0, 80);
          if (q && !this.seenSearches.has(q)) {
            this.seenSearches.add(q);
            newContextDiscovered = true; // New search = new context
          }
          break;
        }
        case 'run_command': {
          const cmd = (args.command || '').trim();
          const currentCount = (this.commandRunCounts.get(cmd) || 0) + 1;
          this.commandRunCounts.set(cmd, currentCount);

          if (currentCount <= this.MAX_COMMAND_REPEATS) {
            hasMutatingCall = true;
            newContextDiscovered = true;
          }
          // If repeated > MAX_COMMAND_REPEATS, this is spinning on the same command
          break;
        }
        case 'write_file': {
          const writeSig = `${args.path}:${(args.content || '').substring(0, 100)}`;
          if (!this.seenWrites.has(writeSig)) {
            this.seenWrites.add(writeSig);
            hasMutatingCall = true;
            newContextDiscovered = true;
          }
          break;
        }
        case 'git_commit':
          hasMutatingCall = true;
          newContextDiscovered = true;
          break;
      }
    }

    // Tool diversity: using different tool types from last iteration = exploration
    const toolDiversitySignal =
      !this.arraysIdentical(thisIterToolNames, this.lastIterationTools) && thisIterToolNames.length > 0;
    this.lastIterationTools = thisIterToolNames;

    const productive = hasMutatingCall || newContextDiscovered || toolDiversitySignal;

    if (productive) {
      this.idleCount = 0;
    } else {
      this.idleCount++;
    }

    return productive;
  }

  isStuck(): boolean {
    return this.idleCount >= this.MAX_IDLE;
  }

  statusLine(): string {
    return `files_seen=${this.seenFiles.size} dirs_seen=${this.seenDirs.size} searches_seen=${this.seenSearches.size} idle=${this.idleCount}/${this.MAX_IDLE}`;
  }

  private arraysIdentical(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
}
