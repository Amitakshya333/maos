/**
 * F5-05: Local Knowledge-Base Search Application Service
 *
 * Implements deterministic semantic similarity search over the validated
 * project-local vector index. Returns exact provenance citations for every
 * match and enforces explicit no-answer behavior when evidence is insufficient.
 *
 * Invariants:
 *   1. Documents are DATA only — returned snippets are untrusted and must never
 *      be executed as instructions, tools, or policy modifiers.
 *   2. Citations must match verified entries in the index — never fabricate citations.
 *   3. When evidence is missing, below threshold, or quarantined, search returns
 *      an explicit no-answer result according to the F5-01 contract.
 *   4. Results are deterministically ranked by score descending, with stable
 *      tie-breaking by documentId, chunkIndex, and chunkId.
 *   5. All vectors must be finite, non-empty, and match the 384-d embedding dimension.
 *   6. Cross-project search attempts are strictly rejected.
 *   7. Zero network activity — missing offline embedding weights fail closed.
 */

import * as path from 'path';
import * as crypto from 'crypto';
import {
  KbSearchInput,
  KbSearchResult,
  KbSearchAnswerResult,
  KbSearchNoAnswerResult,
  KbSearchCitation,
  KB_SEARCH_BOUNDS,
  KbSearchError,
  cosineSimilarity,
  validateKbSearchInput,
} from '../domain/kb-search';
import {
  KbCorpusPolicy,
  KbNoAnswerReason,
  buildNoAnswer,
  createDefaultCorpusPolicy,
} from '../domain/kb-corpus-policy';
import { KbVectorIndexEntry } from '../domain/kb-vector-index';
import { KbVectorIndexService } from './kb-vector-index-service';
import { EmbeddingService } from './embedding-service';
import { KbIngestionService } from './kb-ingestion-service';
import { AuditService } from './audit-service';

export interface KbSearchServiceOptions {
  skipAudit?: boolean;
  _mockQueryVector?: number[];
  _simulateTimeout?: boolean;
  throwOnMissingWeights?: boolean;
}

export class KbSearchService {
  constructor(
    private readonly projectRoot: string,
    private readonly kbIndexService: KbVectorIndexService,
    private readonly embeddingService: EmbeddingService,
    private readonly ingestionService: KbIngestionService,
    private readonly audit?: AuditService,
    private readonly options: KbSearchServiceOptions = {},
  ) {}

  /**
   * Perform semantic similarity search over the validated vector index (async).
   */
  public async search(
    input: KbSearchInput,
    policy?: KbCorpusPolicy,
  ): Promise<KbSearchResult> {
    const startTime = Date.now();
    const context = this.prepareSearchContext(input, policy, startTime);
    if ('result' in context) {
      return context.result;
    }

    const { projectId, activePolicy, manifest, index, corpusDocCount, activeIndexedDocCount, quarantinedDocIds } = context;

    // Generate query vector asynchronously
    let queryVector: readonly number[];
    try {
      if (this.options._mockQueryVector) {
        queryVector = this.options._mockQueryVector;
      } else {
        const embeddingResult = await this.embeddingService.generateEmbeddings({
          projectId,
          items: [
            {
              text: input.query,
              chunkId: 'query',
              chunkIndex: 0,
              documentId: 'query',
              sourceHash: 'query',
              documentVersion: 1,
              charOffsetStart: 0,
              charOffsetEnd: input.query.length,
            },
          ],
        });
        queryVector = embeddingResult.records[0].vector;
      }
    } catch (err: any) {
      if (err.code === 'NO_RUNTIME_DOWNLOAD' || err.message?.includes('NO_RUNTIME_DOWNLOAD')) {
        throw new KbSearchError('NO_RUNTIME_DOWNLOAD', err.message);
      }
      return this.handleNoAnswer(
        'INDEX_NOT_BUILT',
        `Query embedding generation failed: ${err.message}`,
        corpusDocCount,
        index.documentCount,
        input,
        startTime,
      );
    }

    return this.finalizeSearch(
      input,
      index,
      manifest,
      queryVector,
      quarantinedDocIds,
      corpusDocCount,
      startTime,
    );
  }

  /**
   * Perform semantic similarity search over the validated vector index (synchronous).
   * For synchronous tool execution in agent workflows.
   */
  public searchSync(
    input: KbSearchInput,
    policy?: KbCorpusPolicy,
  ): KbSearchResult {
    const startTime = Date.now();
    const context = this.prepareSearchContext(input, policy, startTime);
    if ('result' in context) {
      return context.result;
    }

    const { projectId, activePolicy, manifest, index, corpusDocCount, activeIndexedDocCount, quarantinedDocIds } = context;

    // Generate query vector synchronously
    let queryVector: readonly number[];
    try {
      if (this.options._mockQueryVector) {
        queryVector = this.options._mockQueryVector;
      } else {
        const embeddingResult = this.embeddingService.generateEmbeddingsSync({
          projectId,
          items: [
            {
              text: input.query,
              chunkId: 'query',
              chunkIndex: 0,
              documentId: 'query',
              sourceHash: 'query',
              documentVersion: 1,
              charOffsetStart: 0,
              charOffsetEnd: input.query.length,
            },
          ],
        });
        queryVector = embeddingResult.records[0].vector;
      }
    } catch (err: any) {
      if (err.code === 'NO_RUNTIME_DOWNLOAD' || err.message?.includes('NO_RUNTIME_DOWNLOAD')) {
        throw new KbSearchError('NO_RUNTIME_DOWNLOAD', err.message);
      }
      return this.handleNoAnswer(
        'INDEX_NOT_BUILT',
        `Query embedding generation failed: ${err.message}`,
        corpusDocCount,
        index.documentCount,
        input,
        startTime,
      );
    }

    return this.finalizeSearch(
      input,
      index,
      manifest,
      queryVector,
      quarantinedDocIds,
      corpusDocCount,
      startTime,
    );
  }

  // ── Private Context & Finalization Helpers ─────────────────────────

  private prepareSearchContext(
    input: KbSearchInput,
    policy: KbCorpusPolicy | undefined,
    startTime: number,
  ):
    | { result: KbSearchResult }
    | {
        projectId: string;
        activePolicy: KbCorpusPolicy;
        manifest: any;
        index: any;
        corpusDocCount: number;
        activeIndexedDocCount: number;
        quarantinedDocIds: Set<string>;
      } {
    // 1. Validate typed search input
    const inputValidation = validateKbSearchInput(input);
    if (!inputValidation.valid) {
      throw new KbSearchError(
        'INVALID_INPUT',
        `Invalid search input: ${inputValidation.errors.join('; ')}`,
      );
    }

    const projectId = input.projectId;

    // 2. Enforce project isolation against policy if supplied
    if (policy && policy.projectId !== projectId) {
      throw new KbSearchError(
        'CROSS_PROJECT',
        `Search project "${projectId}" does not match policy project "${policy.projectId}"`,
      );
    }

    const activePolicy = policy || createDefaultCorpusPolicy(projectId);

    // 3. Inspect Ingestion Manifest
    const manifest = this.ingestionService.readManifest();
    const corpusDocCount = manifest ? manifest.documentCount : 0;

    if (!manifest || manifest.projectId !== projectId || manifest.documentCount === 0) {
      return {
        result: this.handleNoAnswer(
          'CORPUS_EMPTY',
          'No ingested documents found in the project knowledge base',
          corpusDocCount,
          0,
          input,
          startTime,
        ),
      };
    }

    // Identify quarantined documents from manifest
    const quarantinedDocIds = new Set<string>();
    let activeIndexedDocCount = 0;
    for (const [docId, record] of Object.entries(manifest.entries)) {
      if (record.entry.status === 'quarantined') {
        quarantinedDocIds.add(docId);
      } else if (record.entry.status === 'indexed') {
        activeIndexedDocCount++;
      }
    }

    // 3b. Check if filter sourcePaths contain path traversal or are outside approved roots
    if (input.filter?.sourcePaths && input.filter.sourcePaths.length > 0) {
      for (const sp of input.filter.sourcePaths) {
        if (sp.includes('..') || path.isAbsolute(sp)) {
          throw new KbSearchError(
            'TRAVERSAL_REJECTED',
            `Filter path contains illegal traversal or absolute path: '${sp}'`,
          );
        }
      }

      const allOutsideApproved = input.filter.sourcePaths.every((sp) => {
        return !activePolicy.approvedRoots.some((root) => {
          const cleanRoot = root.replace(/\/+$/, '');
          return sp === cleanRoot || sp.startsWith(cleanRoot + '/');
        });
      });
      if (allOutsideApproved) {
        return {
          result: this.handleNoAnswer(
            'QUERY_OUT_OF_SCOPE',
            'All requested filter source paths fall outside approved corpus policy roots',
            corpusDocCount,
            activeIndexedDocCount,
            input,
            startTime,
          ),
        };
      }
    }

    // 3c. Check if all documents in corpus are quarantined (ALL_SOURCES_QUARANTINED)
    if (quarantinedDocIds.size > 0 && activeIndexedDocCount === 0) {
      return {
        result: this.handleNoAnswer(
          'ALL_SOURCES_QUARANTINED',
          'All documents in the corpus are quarantined due to prompt injection detection',
          corpusDocCount,
          0,
          input,
          startTime,
        ),
      };
    }

    // 4. Check Index Status (fast check for missing/stale/corrupt)
    const indexStatus = this.kbIndexService.checkIndexStatus(projectId, activePolicy);
    if (indexStatus.status === 'missing') {
      return {
        result: this.handleNoAnswer(
          'INDEX_NOT_BUILT',
          'Vector index has not been built for this project',
          corpusDocCount,
          0,
          input,
          startTime,
        ),
      };
    }
    if (indexStatus.status === 'stale') {
      return {
        result: this.handleNoAnswer(
          'INDEX_NOT_BUILT',
          `Vector index is stale: ${indexStatus.reason || 'Source documents or policy changed'}`,
          corpusDocCount,
          activeIndexedDocCount,
          input,
          startTime,
        ),
      };
    }
    if (indexStatus.status === 'corrupt') {
      return {
        result: this.handleNoAnswer(
          'INDEX_NOT_BUILT',
          `Vector index is corrupt: ${indexStatus.reason || 'Integrity check failed'}`,
          corpusDocCount,
          0,
          input,
          startTime,
        ),
      };
    }

    // 5. Load and Verify Index (fails closed on tampered or corrupt index)
    let index;
    try {
      index = this.kbIndexService.loadIndex(projectId);
    } catch (err: any) {
      return {
        result: this.handleNoAnswer(
          'INDEX_NOT_BUILT',
          `Vector index verification failed: ${err.message}`,
          corpusDocCount,
          0,
          input,
          startTime,
        ),
      };
    }

    if (!index || index.entries.length === 0) {
      return {
        result: this.handleNoAnswer(
          'CORPUS_EMPTY',
          'Vector index contains no chunk entries',
          corpusDocCount,
          0,
          input,
          startTime,
        ),
      };
    }

    return {
      projectId,
      activePolicy,
      manifest,
      index,
      corpusDocCount,
      activeIndexedDocCount,
      quarantinedDocIds,
    };
  }

  private finalizeSearch(
    input: KbSearchInput,
    index: any,
    manifest: any,
    queryVector: readonly number[],
    quarantinedDocIds: Set<string>,
    corpusDocCount: number,
    startTime: number,
  ): KbSearchResult {
    const projectId = input.projectId;

    if (!queryVector || queryVector.length !== KB_SEARCH_BOUNDS.dimension) {
      return this.handleNoAnswer(
        'INDEX_NOT_BUILT',
        `Query vector dimension mismatch: expected ${KB_SEARCH_BOUNDS.dimension}, got ${queryVector?.length}`,
        corpusDocCount,
        index.documentCount,
        input,
        startTime,
      );
    }

    // 7. Filter and Score Entries
    const minScore = input.minScore ?? KB_SEARCH_BOUNDS.defaultMinScore;
    const filter = input.filter;

    interface ScoredEntry {
      entry: KbVectorIndexEntry;
      score: number;
    }

    const eligibleMatches: ScoredEntry[] = [];
    let matchingQuarantinedCount = 0;

    for (const entry of index.entries) {
      // Exclude any entry belonging to a quarantined document
      if (quarantinedDocIds.has(entry.documentId)) {
        matchingQuarantinedCount++;
        continue;
      }

      // Metadata filter: sourcePaths
      if (filter?.sourcePaths && filter.sourcePaths.length > 0) {
        if (!filter.sourcePaths.includes(entry.sourcePath)) {
          continue;
        }
      }

      // Metadata filter: documentIds
      if (filter?.documentIds && filter.documentIds.length > 0) {
        if (!filter.documentIds.includes(entry.documentId)) {
          continue;
        }
      }

      // Metadata filter: mimeTypes
      if (filter?.mimeTypes && filter.mimeTypes.length > 0) {
        const docRecord = manifest.entries[entry.documentId];
        if (!docRecord || !filter.mimeTypes.includes(docRecord.entry.mimeType)) {
          continue;
        }
      }

      // Metadata filter: pageNumbers
      if (filter?.pageNumbers && filter.pageNumbers.length > 0) {
        if (entry.pageNumber === undefined || !filter.pageNumbers.includes(entry.pageNumber)) {
          continue;
        }
      }

      // Metadata filter: sectionHeadings
      if (filter?.sectionHeadings && filter.sectionHeadings.length > 0) {
        if (entry.sectionHeading === undefined || !filter.sectionHeadings.includes(entry.sectionHeading)) {
          continue;
        }
      }

      // Compute deterministic cosine similarity
      const score = cosineSimilarity(queryVector, entry.vector, KB_SEARCH_BOUNDS.dimension);

      // Score threshold filtering
      if (score >= minScore) {
        eligibleMatches.push({ entry, score });
      }
    }

    // 8. Check for No-Answer Conditions
    if (eligibleMatches.length === 0) {
      if (matchingQuarantinedCount > 0 && index.entries.every((e: any) => quarantinedDocIds.has(e.documentId))) {
        return this.handleNoAnswer(
          'ALL_SOURCES_QUARANTINED',
          'All matching candidate chunks originate from quarantined documents',
          corpusDocCount,
          index.documentCount,
          input,
          startTime,
        );
      }
      return this.handleNoAnswer(
        'BELOW_CONFIDENCE_THRESHOLD',
        `No document passages met the minimum similarity score threshold of ${minScore}`,
        corpusDocCount,
        index.documentCount,
        input,
        startTime,
      );
    }

    // 9. Deterministic Ranking
    // Primary: score descending
    // Tie-break 1: documentId ascending
    // Tie-break 2: chunkIndex ascending
    // Tie-break 3: chunkId ascending
    eligibleMatches.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const docCmp = a.entry.documentId.localeCompare(b.entry.documentId);
      if (docCmp !== 0) return docCmp;
      if (a.entry.chunkIndex !== b.entry.chunkIndex) {
        return a.entry.chunkIndex - b.entry.chunkIndex;
      }
      return a.entry.chunkId.localeCompare(b.entry.chunkId);
    });

    // 10. Slice TopK
    const topK = input.topK ?? KB_SEARCH_BOUNDS.defaultTopK;
    const sliced = eligibleMatches.slice(0, topK);

    // 11. Hydrate Snippets from Safe Chunk Storage
    const chunkCache = new Map<string, Record<string, string>>();
    const citations: KbSearchCitation[] = [];

    for (const match of sliced) {
      const { entry, score } = match;

      let docChunkMap = chunkCache.get(entry.documentId);
      if (!docChunkMap) {
        docChunkMap = {};
        const chunks = this.ingestionService.readChunks(entry.documentId);
        if (chunks) {
          for (const c of chunks) {
            docChunkMap[c.chunkId] = c.chunkText;
          }
        }
        chunkCache.set(entry.documentId, docChunkMap);
      }

      const snippet = docChunkMap[entry.chunkId] || '';

      citations.push({
        documentId: entry.documentId,
        chunkId: entry.chunkId,
        sourcePath: entry.sourcePath,
        canonicalPath: entry.sourcePath,
        pageNumber: entry.pageNumber,
        sectionHeading: entry.sectionHeading,
        sourceHash: entry.sourceHash,
        documentVersion: entry.documentVersion,
        chunkIndex: entry.chunkIndex,
        charOffsetStart: entry.charOffsetStart,
        charOffsetEnd: entry.charOffsetEnd,
        score,
        indexBuildId: index.indexBuildId,
        embeddingModelId: index.embeddingModelId,
        embeddingModelRevision: index.embeddingModelRevision,
        snippet,
      });
    }

    const durationMs = Date.now() - startTime;

    // 12. Record Audit Event (Zero raw text logged)
    if (this.audit && !this.options.skipAudit) {
      try {
        const queryHash = crypto.createHash('sha256').update(input.query).digest('hex');
        this.audit.recordAuditEvent({
          source: 'kb-search-service',
          category: 'model',
          data: {
            event: 'KB_SEARCH_EXECUTED',
            projectId,
            queryHash,
            queryLength: input.query.length,
            answered: true,
            totalMatches: eligibleMatches.length,
            returnedMatches: citations.length,
            topScore: citations.length > 0 ? citations[0].score : 0.0,
            durationMs,
            indexBuildId: index.indexBuildId,
          },
        });
      } catch {
        // Audit emission is non-fatal for search response
      }
    }

    const result: KbSearchAnswerResult = {
      schemaVersion: 1,
      answered: true,
      projectId,
      query: input.query,
      durationMs,
      totalMatches: eligibleMatches.length,
      returnedMatches: citations.length,
      citations: Object.freeze(citations),
      indexBuildId: index.indexBuildId,
      embeddingModelId: index.embeddingModelId,
      embeddingModelRevision: index.embeddingModelRevision,
    };

    return Object.freeze(result);
  }

  // ── Helper: No-Answer Handler ──────────────────────────────────────

  private handleNoAnswer(
    reason: KbNoAnswerReason,
    details: string,
    corpusDocumentCount: number,
    indexedDocumentCount: number,
    input: KbSearchInput,
    startTime: number,
  ): KbSearchNoAnswerResult {
    const durationMs = Date.now() - startTime;
    const baseNoAnswer = buildNoAnswer(
      reason,
      details,
      corpusDocumentCount,
      indexedDocumentCount,
    );

    // Record Audit Event for No-Answer (Zero raw text logged)
    if (this.audit && !this.options.skipAudit) {
      try {
        const queryHash = crypto.createHash('sha256').update(input.query).digest('hex');
        this.audit.recordAuditEvent({
          source: 'kb-search-service',
          category: 'model',
          data: {
            event: 'KB_SEARCH_NO_ANSWER',
            projectId: input.projectId,
            queryHash,
            queryLength: input.query.length,
            answered: false,
            reason,
            details,
            durationMs,
          },
        });
      } catch {
        // Audit emission is non-fatal
      }
    }

    const noAnswerResult: KbSearchNoAnswerResult = {
      ...baseNoAnswer,
      schemaVersion: 1,
      projectId: input.projectId,
      query: input.query,
      durationMs,
      citations: Object.freeze([]) as readonly [],
    };

    return Object.freeze(noAnswerResult);
  }
}
