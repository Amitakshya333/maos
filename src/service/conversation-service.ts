/**
 * MAOS Conversation Service
 *
 * Manages chat conversations, attachments, and task promotions under .maos/conversations/.
 * Features:
 *   - Atomic file writes (temp file -> fsync -> rename)
 *   - Path traversal and project-escape prevention
 *   - Cross-project conversation isolation
 *   - Attachment validation (size limits and project root confinement)
 *   - Explicit promote-to-task transition
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Conversation, Message, MessageRole, Task } from '../domain/schemas';
import {
  ChatAttachment,
  ATTACHMENT_BOUNDS,
  validateChatAttachment,
  PromoteToTaskInput,
  PromoteToTaskResult,
  validatePromoteToTaskInput,
  ProjectFileInfo,
} from '../domain/conversation';
import {
  OperationalMode,
  CitedClaim,
  validateOperationalMode,
  validateModeTransition,
  validateCitedClaim,
  normalizeOperationalMode,
} from '../domain/evidence-mode';
import type { TaskService } from './task-service';

export class ConversationService {
  private readonly storageDir: string;

  constructor(private readonly projectRoot: string) {
    this.storageDir = path.join(this.projectRoot, '.maos', 'conversations');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private assertSafeId(id: string): void {
    if (!id || typeof id !== 'string' || id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) {
      throw new Error(`PATH_TRAVERSAL: Invalid conversation ID "${id}"`);
    }
  }

  private writeAtomic(filePath: string, content: string): void {
    this.ensureDir();
    const tmpPath = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * List all conversations, optionally filtered by projectId.
   */
  listConversations(projectId?: string): Conversation[] {
    if (projectId && (projectId.includes('..') || projectId.includes('/') || projectId.includes('\\') || projectId.includes('\0'))) {
      throw new Error(`PATH_TRAVERSAL: Invalid project ID "${projectId}"`);
    }

    this.ensureDir();
    const files = fs.readdirSync(this.storageDir).filter((f) => f.endsWith('.json') && !f.includes('.tmp.'));
    const conversations: Conversation[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.storageDir, file), 'utf-8');
        const conv = JSON.parse(content) as Conversation;
        if (!projectId || conv.projectId === projectId) {
          conversations.push(conv);
        }
      } catch {
        /* skip corrupted files */
      }
    }

    return conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Retrieve a conversation by its ID.
   */
  getConversation(id: string): Conversation | null {
    this.assertSafeId(id);
    this.ensureDir();
    const filePath = path.join(this.storageDir, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as Conversation;
    } catch {
      return null;
    }
  }

  /**
   * Create a new conversation.
   */
  createConversation(
    optsOrProjectId:
      | string
      | {
          id?: string;
          projectId: string;
          agentId: string;
          taskId?: string;
          mode?: OperationalMode;
          pinned?: boolean;
          messages?: Message[];
        },
    agentIdArg?: string,
  ): Conversation {
    const opts =
      typeof optsOrProjectId === 'string'
        ? { projectId: optsOrProjectId, agentId: agentIdArg || 'developer' }
        : optsOrProjectId;

    if (opts.id) {
      this.assertSafeId(opts.id);
    }
    if (!opts.projectId || typeof opts.projectId !== 'string') {
      throw new Error('VALIDATION_FAILED: projectId is required');
    }
    if (opts.projectId.includes('..') || opts.projectId.includes('/') || opts.projectId.includes('\\') || opts.projectId.includes('\0')) {
      throw new Error(`PATH_TRAVERSAL: Invalid project ID "${opts.projectId}"`);
    }
    if (!opts.agentId || typeof opts.agentId !== 'string') {
      throw new Error('VALIDATION_FAILED: agentId is required');
    }

    if (opts.mode) {
      const modeVal = validateOperationalMode(opts.mode);
      if (!modeVal.valid) {
        throw new Error(`VALIDATION_FAILED: ${modeVal.errors.join('; ')}`);
      }
    }

    this.ensureDir();
    const now = new Date().toISOString();
    const id = opts.id || `conv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const conv: Conversation = {
      schemaVersion: 1,
      id,
      projectId: opts.projectId,
      agentId: opts.agentId,
      taskId: opts.taskId,
      mode: opts.mode || 'evidence',
      pinned: opts.pinned ?? false,
      messages: opts.messages || [],
      createdAt: now,
      updatedAt: now,
    };

    const filePath = path.join(this.storageDir, `${id}.json`);
    this.writeAtomic(filePath, JSON.stringify(conv, null, 2));
    return conv;
  }

  /**
   * Update the operational mode of a conversation with silent downgrade defense.
   */
  updateMode(
    conversationId: string,
    newMode: OperationalMode,
    confirmed = false,
  ): Conversation {
    this.assertSafeId(conversationId);
    const conv = this.getConversation(conversationId);
    if (!conv) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const currentMode = conv.mode || 'evidence';
    const transitionCheck = validateModeTransition(currentMode, newMode, confirmed);
    if (!transitionCheck.valid) {
      throw new Error(transitionCheck.errors.join('; '));
    }

    const now = new Date().toISOString();
    const updated: Conversation = {
      ...conv,
      mode: newMode,
      updatedAt: now,
    };

    const filePath = path.join(this.storageDir, `${conversationId}.json`);
    this.writeAtomic(filePath, JSON.stringify(updated, null, 2));
    return updated;
  }

  /**
   * Pin or unpin a conversation to protect it from retention purges.
   */
  setPinned(conversationId: string, pinned: boolean): Conversation {
    this.assertSafeId(conversationId);
    const conv = this.getConversation(conversationId);
    if (!conv) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const now = new Date().toISOString();
    const updated: Conversation = {
      ...conv,
      pinned,
      updatedAt: now,
    };

    const filePath = path.join(this.storageDir, `${conversationId}.json`);
    this.writeAtomic(filePath, JSON.stringify(updated, null, 2));
    return updated;
  }

  /**
   * Add a message to an existing conversation.
   */
  addMessage(
    conversationId: string,
    msg: {
      role: MessageRole;
      content: string | null;
      name?: string;
      toolCallId?: string;
      toolCalls?: any[];
      tokenUsage?: any;
      attachments?: ChatAttachment[];
      mode?: OperationalMode;
      claims?: CitedClaim[];
      isModelGenerated?: boolean;
      verifiedAgainstData?: boolean;
    },
  ): Message {
    this.assertSafeId(conversationId);
    const conv = this.getConversation(conversationId);
    if (!conv) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    // Determine operational mode for message validation
    const activeMode = msg.mode || conv.mode || 'evidence';

    // Validate claims if present
    if (msg.claims && Array.isArray(msg.claims)) {
      for (const claim of msg.claims) {
        const claimVal = validateCitedClaim(claim, activeMode);
        if (!claimVal.valid) {
          throw new Error(claimVal.errors.join('; '));
        }
      }
    }

    // Validate attachments if present
    if (msg.attachments && Array.isArray(msg.attachments)) {
      if (msg.attachments.length > ATTACHMENT_BOUNDS.MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new Error(`OVERSIZED_ATTACHMENT: Exceeds max attachments per message (${ATTACHMENT_BOUNDS.MAX_ATTACHMENTS_PER_MESSAGE})`);
      }
      for (const att of msg.attachments) {
        const val = validateChatAttachment(att);
        if (!val.valid) {
          throw new Error(`INVALID_ATTACHMENT: ${val.errors.join('; ')}`);
        }
        // Verify relativePath stays inside project root
        const resolved = path.resolve(this.projectRoot, att.relativePath);
        const resolvedRoot = path.resolve(this.projectRoot);
        if (!resolved.startsWith(resolvedRoot) || resolved.includes('\0')) {
          throw new Error(`PATH_OUTSIDE_PROJECT: Attachment path "${att.relativePath}" escapes project root`);
        }
      }
    }

    const now = new Date().toISOString();
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fullMessage: Message = {
      schemaVersion: 1,
      id: messageId,
      role: msg.role,
      content: msg.content,
      name: msg.name,
      toolCallId: msg.toolCallId,
      toolCalls: msg.toolCalls,
      timestamp: now,
      tokenUsage: msg.tokenUsage,
      mode: msg.mode || conv.mode,
      claims: msg.claims,
      isModelGenerated: msg.isModelGenerated,
      verifiedAgainstData: msg.verifiedAgainstData,
      attachments: msg.attachments,
    };

    const updated: Conversation = {
      ...conv,
      messages: [...conv.messages, fullMessage],
      updatedAt: now,
    };

    const filePath = path.join(this.storageDir, `${conversationId}.json`);
    this.writeAtomic(filePath, JSON.stringify(updated, null, 2));
    return fullMessage;
  }

  /**
   * Promotes an exploratory chat session into a formally orchestrated task.
   */
  promoteToTask(
    conversationId: string,
    input: PromoteToTaskInput,
    taskService: TaskService,
  ): PromoteToTaskResult {
    this.assertSafeId(conversationId);
    const conv = this.getConversation(conversationId);
    if (!conv) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const validation = validatePromoteToTaskInput({ ...input, conversationId });
    if (!validation.valid) {
      throw new Error(`VALIDATION_FAILED: ${validation.errors.join('; ')}`);
    }

    // Invariant: Unverified brainstorm content cannot be promoted to tasks without explicit review confirmation
    const convMode = conv.mode ? normalizeOperationalMode(conv.mode) : 'evidence';
    let unverifiedClaimsCount = 0;
    for (const msg of conv.messages) {
      if (msg.claims && Array.isArray(msg.claims)) {
        for (const claim of msg.claims) {
          if (claim.isModelGenerated && !claim.verifiedAgainstData) {
            unverifiedClaimsCount++;
          }
        }
      }
    }

    if ((convMode === 'brainstorm' || unverifiedClaimsCount > 0) && !input.allowUnreviewedBrainstorm) {
      throw new Error(
        `BRAINSTORM_UNVERIFIED_CLAIM_REQUIRES_REVIEW: Cannot promote brainstorm exploration to a task without review. Found ${unverifiedClaimsCount} unverified claim(s). Set allowUnreviewedBrainstorm: true to confirm task promotion.`,
      );
    }

    // Validate attachments if present in promotion input
    if (input.attachments && Array.isArray(input.attachments)) {
      for (const att of input.attachments) {
        const val = validateChatAttachment(att);
        if (!val.valid) {
          throw new Error(`INVALID_ATTACHMENT: ${val.errors.join('; ')}`);
        }
        const resolved = path.resolve(this.projectRoot, att.relativePath);
        const resolvedRoot = path.resolve(this.projectRoot);
        if (!resolved.startsWith(resolvedRoot) || resolved.includes('\0')) {
          throw new Error(`PATH_OUTSIDE_PROJECT: Attachment path "${att.relativePath}" escapes project root`);
        }
      }
    }

    const task = taskService.createTask({
      description: input.description,
      agent: input.agent || conv.agentId,
      branch: input.branch || 'main',
      complexity: input.complexity || 'medium',
      category: input.category || 'general',
      requirements: input.attachments && input.attachments.length > 0 ? {
        schemaVersion: 1,
        modalities: ['text'],
        input: {
          requiredArtifactTypes: input.attachments.map((a) => a.name),
          maxInputSizeBytes: input.attachments.reduce((sum, a) => sum + a.sizeBytes, 0) || undefined,
        },
      } : undefined,
    });

    const now = new Date().toISOString();
    const updated: Conversation = {
      ...conv,
      taskId: task.id,
      updatedAt: now,
    };

    const filePath = path.join(this.storageDir, `${conversationId}.json`);
    this.writeAtomic(filePath, JSON.stringify(updated, null, 2));

    return { task, conversation: updated };
  }

  /**
   * Delete a conversation.
   */
  deleteConversation(id: string): boolean {
    this.assertSafeId(id);
    this.ensureDir();
    const filePath = path.join(this.storageDir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  /**
   * List files within the project root, safely confined and excluding internal/hidden dirs.
   */
  listProjectFiles(subpath?: string): ProjectFileInfo[] {
    const requestedSubpath = subpath || '';
    if (
      requestedSubpath.includes('..') ||
      requestedSubpath.includes('\0') ||
      path.isAbsolute(requestedSubpath) ||
      requestedSubpath.startsWith('/') ||
      requestedSubpath.startsWith('\\')
    ) {
      throw new Error('Path traversal rejected: invalid subpath');
    }

    const canonicalRoot = path.resolve(this.projectRoot);
    const targetDir = path.resolve(this.projectRoot, requestedSubpath);
    if (!targetDir.startsWith(canonicalRoot)) {
      throw new Error('PATH_OUTSIDE_PROJECT: Requested path outside project root');
    }

    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      throw new Error(`NOT_FOUND: Directory not found: ${requestedSubpath}`);
    }

    const IGNORED_DIRS = new Set(['.maos', '.git', 'node_modules', 'dist', '.gemini']);
    const files: ProjectFileInfo[] = [];

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      const fullPath = path.join(targetDir, entry.name);
      const relPath = path.relative(canonicalRoot, fullPath).replace(/\\/g, '/');
      let size = 0;
      let isDir = entry.isDirectory();
      try {
        const stat = fs.statSync(fullPath);
        size = stat.size;
        isDir = stat.isDirectory();
      } catch {
        // skip if inaccessible
      }
      const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '');
      files.push({
        path: relPath,
        name: entry.name,
        size,
        isDirectory: isDir,
        extension: ext || undefined,
      });
      if (files.length >= 500) break;
    }

    return files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }
}
