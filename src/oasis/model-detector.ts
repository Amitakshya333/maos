/**
 * MAOS Oasis Local Model Detector
 *
 * Dynamically detects installed local LLM models:
 * 1. Queries local Ollama daemon (GET /api/tags) for all downloaded models (gemma2, gemma4, qwen, etc.).
 * 2. Scans Hugging Face hub cache directories (~/.cache/huggingface/hub, ~/.cache/huggingface/hub/.locks).
 * 3. Scans local model and experiments directories (~/experiments, ~/models, ./models).
 * 4. Filters and formats models with friendly names and parameter sizing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DetectedModel {
  id: string;
  name: string;
  source: 'ollama' | 'huggingface' | 'local' | 'fallback';
  family?: string;
  parameterSize?: string;
  format?: string;
  sizeBytes?: number;
  path?: string;
  active?: boolean;
}

export const FALLBACK_MODELS: DetectedModel[] = [
  {
    id: 'gemma2:9b',
    name: 'Gemma 2 (9B)',
    source: 'fallback',
    family: 'gemma2',
    parameterSize: '9B',
  },
  {
    id: 'gemma2:2b',
    name: 'Gemma 2 (2B)',
    source: 'fallback',
    family: 'gemma2',
    parameterSize: '2B',
  },
  {
    id: 'gemma4:e2b',
    name: 'Gemma 4 (e2b)',
    source: 'fallback',
    family: 'gemma4',
    parameterSize: '4.6B',
  },
  {
    id: 'qwen2.5-coder:7b',
    name: 'Qwen 2.5 Coder (7B)',
    source: 'fallback',
    family: 'qwen',
    parameterSize: '7B',
  },
];

/**
 * Formats a raw model ID into a clean, human-readable display name.
 */
export function formatModelDisplayName(rawId: string, details?: { family?: string; parameterSize?: string }): string {
  const lower = rawId.toLowerCase();

  // Gemma models
  if (lower.startsWith('gemma2:2b')) return 'Gemma 2 (2B)';
  if (lower.startsWith('gemma2:9b')) return 'Gemma 2 (9B)';
  if (lower.startsWith('gemma2:27b')) return 'Gemma 2 (27B)';
  if (lower.startsWith('gemma4:e2b')) return 'Gemma 4 (e2b)';
  if (lower.startsWith('gemma3:4b')) return 'Gemma 3 (4B)';
  if (lower.startsWith('gemma3:12b')) return 'Gemma 3 (12B)';
  if (lower.startsWith('gemma')) {
    const parts = rawId.split(':');
    const version = parts[0].replace('gemma', 'Gemma ');
    const tag = parts[1] ? ` (${parts[1]})` : '';
    return `${version}${tag}`;
  }

  // Qwen models
  if (lower.includes('qwen2.5-coder')) {
    const tag = rawId.split(':')[1] || details?.parameterSize || 'Coder';
    return `Qwen 2.5 Coder (${tag})`;
  }
  if (lower.includes('qwen2.5-3b') || lower.includes('qwen2.5-3b-instruct')) {
    return 'Qwen 2.5 (3B Instruct)';
  }
  if (lower.includes('qwen2.5-7b') || lower.includes('qwen2.5-7b-instruct')) {
    return 'Qwen 2.5 (7B Instruct)';
  }
  if (lower.includes('qwen')) {
    const name = rawId.split('/').pop()?.split(':')[0] || rawId;
    return name.replace(/^qwen[-_.]?/i, 'Qwen ');
  }

  // Generic formatting
  if (rawId.includes('/')) {
    const leaf = rawId.split('/').pop() || rawId;
    return leaf.replace(/[-_]/g, ' ');
  }
  if (rawId.includes(':')) {
    const [name, tag] = rawId.split(':');
    return `${name.toUpperCase()} (${tag})`;
  }

  return rawId;
}

/**
 * Formats a model ID for top header badges: e.g. "GEMMA 4 E2B · LOCAL"
 */
export function formatHeaderBadge(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('gemma4:e2b')) return 'GEMMA 4 E2B · LOCAL';
  if (lower.startsWith('gemma2:9b')) return 'GEMMA 2 9B · LOCAL';
  if (lower.startsWith('gemma2:2b')) return 'GEMMA 2 2B · LOCAL';
  if (lower.startsWith('gemma3:4b')) return 'GEMMA 3 4B · LOCAL';
  if (lower.startsWith('gemma')) {
    const parts = modelId.split(':');
    return `${parts[0].toUpperCase()} ${parts[1]?.toUpperCase() || ''} · LOCAL`.trim();
  }
  if (lower.includes('qwen')) {
    const short = lower.includes('coder') ? 'QWEN CODER' : lower.includes('3b') ? 'QWEN 2.5 3B' : 'QWEN 2.5';
    return `${short} · LOCAL`;
  }
  return `${modelId.split('/').pop()?.split(':')[0]?.toUpperCase() || modelId.toUpperCase()} · LOCAL`;
}

/**
 * Queries Ollama API GET /api/tags
 */
export async function fetchOllamaModels(host = '127.0.0.1', port = 11434, timeoutMs = 2500): Promise<DetectedModel[]> {
  try {
    const res = await fetch(`http://${host}:${port}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: Array<{
        name: string;
        model: string;
        size?: number;
        details?: {
          family?: string;
          parameter_size?: string;
          format?: string;
        };
      }>;
    };
    if (!Array.isArray(data.models)) return [];

    return data.models.map((m) => {
      const family = m.details?.family || m.name.split(':')[0];
      const paramSize = m.details?.parameter_size;
      return {
        id: m.name,
        name: formatModelDisplayName(m.name, { family, parameterSize: paramSize }),
        source: 'ollama',
        family,
        parameterSize: paramSize,
        format: m.details?.format || 'gguf',
        sizeBytes: m.size,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Scans local Hugging Face and disk directories for cached LLM models.
 */
export function scanDiskModels(): DetectedModel[] {
  const models: DetectedModel[] = [];
  const home = os.homedir();

  // 1. HuggingFace Hub directory & locks
  const hfDirs = [
    process.env.HF_HOME ? path.join(process.env.HF_HOME, 'hub') : null,
    process.env.HUGGINGFACE_HUB_CACHE || null,
    path.join(home, '.cache', 'huggingface', 'hub'),
    path.join(home, '.cache', 'huggingface', 'hub', '.locks'),
  ].filter((d): d is string => typeof d === 'string' && fs.existsSync(d));

  const seenIds = new Set<string>();

  for (const hfDir of hfDirs) {
    try {
      const entries = fs.readdirSync(hfDir);
      for (const entry of entries) {
        if (!entry.startsWith('models--')) continue;
        const rawModelName = entry.replace(/^models--/, '');
        const parts = rawModelName.split('--');
        const modelId = parts.join('/');
        const lower = modelId.toLowerCase();

        // Focus on LLM, chat, code, or instruction models
        const isLlm =
          lower.includes('qwen') ||
          lower.includes('gemma') ||
          lower.includes('llama') ||
          lower.includes('coder') ||
          lower.includes('deepseek') ||
          lower.includes('mistral') ||
          lower.includes('phi');

        if (isLlm && !seenIds.has(modelId.toLowerCase())) {
          seenIds.add(modelId.toLowerCase());
          models.push({
            id: modelId,
            name: `${formatModelDisplayName(modelId)} (HF)`,
            source: 'huggingface',
            family: lower.includes('qwen') ? 'qwen' : lower.includes('gemma') ? 'gemma' : 'llm',
            path: path.join(hfDir, entry),
          });
        }
      }
    } catch {
      /* ignore read errors */
    }
  }

  // 2. Local experiments & models directories
  const localDirs = [
    path.join(home, 'experiments'),
    path.join(home, 'models'),
    path.join(process.cwd(), 'models'),
  ].filter((d) => fs.existsSync(d));

  for (const dir of localDirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const lower = entry.name.toLowerCase();
        if (lower.includes('qwen') || lower.includes('gemma') || lower.includes('coder') || lower.includes('llm')) {
          const entryPath = path.join(dir, entry.name);
          let baseModel: string | undefined;

          // Check for adapter_config.json or config.json
          const adapterFile = path.join(entryPath, 'adapter_config.json');
          if (fs.existsSync(adapterFile)) {
            try {
              const cfg = JSON.parse(fs.readFileSync(adapterFile, 'utf-8'));
              baseModel = cfg.base_model_name_or_path;
            } catch {}
          }

          const modelId = baseModel || entry.name;
          if (!seenIds.has(modelId.toLowerCase())) {
            seenIds.add(modelId.toLowerCase());
            models.push({
              id: modelId,
              name: `${formatModelDisplayName(modelId)} (Local)`,
              source: 'local',
              family: lower.includes('qwen') ? 'qwen' : lower.includes('gemma') ? 'gemma' : 'llm',
              path: entryPath,
            });
          }
        }
      }
    } catch {
      /* ignore read errors */
    }
  }

  return models;
}

/**
 * Detects all available local models across Ollama and disk storage.
 */
export async function detectLocalModels(options?: {
  ollamaHost?: string;
  ollamaPort?: number;
  timeoutMs?: number;
}): Promise<DetectedModel[]> {
  const host = options?.ollamaHost || '127.0.0.1';
  const port = options?.ollamaPort || 11434;
  const timeoutMs = options?.timeoutMs || 2500;

  const [ollamaModels, diskModels] = await Promise.all([
    fetchOllamaModels(host, port, timeoutMs),
    Promise.resolve(scanDiskModels()),
  ]);

  const combined: DetectedModel[] = [];
  const seen = new Set<string>();

  // Add Ollama models first (primary executable runtime)
  for (const m of ollamaModels) {
    const key = m.id.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      combined.push(m);
    }
  }

  // Add disk/HF models
  for (const m of diskModels) {
    const key = m.id.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      combined.push(m);
    }
  }

  // Fallbacks if nothing detected
  if (combined.length === 0) {
    return [...FALLBACK_MODELS];
  }

  // Ensure standard Gemma models are present as fallbacks if not returned
  for (const fallback of FALLBACK_MODELS) {
    const key = fallback.id.toLowerCase();
    if (!seen.has(key)) {
      // Don't add all fallbacks if we have live models, but keep gemma2:9b and gemma2:2b available
      if (fallback.id.startsWith('gemma2:')) {
        combined.push(fallback);
        seen.add(key);
      }
    }
  }

  return combined;
}
