import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createLogger } from '../utils/logger';

const logger = createLogger();

/**
 * MAOS Codebase Brain
 *
 * Scans the project and generates a structured understanding:
 * - file-map.json: every file with path, size, type, language
 * - architecture.md: auto-generated project summary
 *
 * This context is injected into agent system prompts to reduce
 * token usage and improve accuracy. Agents that understand the
 * codebase structure need fewer "list_dir" and "read_file" calls.
 */

export interface FileEntry {
  path: string;
  size: number;
  type: 'file' | 'dir';
  language?: string;
  category?: string;
}

export interface BrainData {
  generatedAt: string;
  projectRoot: string;
  totalFiles: number;
  totalSize: number;
  languages: Record<string, number>;
  structure: Record<string, string[]>;
  files: FileEntry[];
}

// Language detection by extension
const LANG_MAP: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript/React', '.js': 'JavaScript', '.jsx': 'JavaScript/React',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
  '.c': 'C', '.cpp': 'C++', '.cs': 'C#', '.swift': 'Swift', '.kt': 'Kotlin',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.less': 'LESS',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
  '.md': 'Markdown', '.txt': 'Text', '.sql': 'SQL',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.ps1': 'PowerShell',
  '.dockerfile': 'Docker', '.proto': 'Protobuf', '.graphql': 'GraphQL',
  '.env': 'Environment', '.gitignore': 'Git', '.editorconfig': 'Config',
};

// Category detection by path patterns
function categorizeFile(filePath: string): string {
  const lower = filePath.toLowerCase().replace(/\\/g, '/');
  if (lower.includes('/test') || lower.includes('.test.') || lower.includes('.spec.')) return 'test';
  if (lower.includes('/src/components') || lower.includes('/components/')) return 'component';
  if (lower.includes('/src/hooks') || lower.includes('/hooks/')) return 'hook';
  if (lower.includes('/src/api') || lower.includes('/routes/') || lower.includes('/controllers/')) return 'api';
  if (lower.includes('/src/utils') || lower.includes('/lib/') || lower.includes('/helpers/')) return 'utility';
  if (lower.includes('/src/styles') || lower.includes('.css') || lower.includes('.scss')) return 'style';
  if (lower.includes('config') || lower.includes('.config.') || lower.includes('.rc')) return 'config';
  if (lower.includes('/src/models') || lower.includes('/schemas/') || lower.includes('/types/')) return 'model';
  if (lower.includes('/migrations/') || lower.includes('/seeds/')) return 'database';
  if (lower.includes('/public/') || lower.includes('/static/') || lower.includes('/assets/')) return 'static';
  if (lower.includes('/docs/') || lower.endsWith('.md')) return 'documentation';
  if (lower.includes('/scripts/') || lower.includes('/bin/')) return 'script';
  return 'source';
}

/**
 * Scan the project and generate brain data.
 */
export function scanProject(projectRoot: string): BrainData {
  // Get tracked files via git
  let trackedFiles: string[];
  try {
    const output = execSync('git ls-files', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 10000,
    });
    trackedFiles = output.split('\n').filter(f => f.trim().length > 0);
  } catch {
    // Fallback: walk directory manually (skip node_modules, .git, etc.)
    trackedFiles = walkDir(projectRoot, projectRoot);
  }

  const files: FileEntry[] = [];
  const languages: Record<string, number> = {};
  const structure: Record<string, string[]> = {};
  let totalSize = 0;

  for (const relPath of trackedFiles) {
    const absPath = path.join(projectRoot, relPath);

    // Skip binary and large files
    if (!fs.existsSync(absPath)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch { continue; }

    if (stat.isDirectory()) continue;

    const ext = path.extname(relPath).toLowerCase();
    const lang = LANG_MAP[ext] || (ext ? ext.substring(1).toUpperCase() : 'Unknown');
    const category = categorizeFile(relPath);

    files.push({
      path: relPath.replace(/\\/g, '/'),
      size: stat.size,
      type: 'file',
      language: lang,
      category,
    });

    totalSize += stat.size;
    languages[lang] = (languages[lang] || 0) + 1;

    // Build directory structure
    const dir = path.dirname(relPath).replace(/\\/g, '/');
    if (!structure[dir]) structure[dir] = [];
    structure[dir].push(path.basename(relPath));
  }

  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    totalFiles: files.length,
    totalSize,
    languages,
    structure,
    files,
  };
}

/**
 * Generate a markdown architecture summary from brain data.
 */
export function generateArchitectureMd(brain: BrainData): string {
  const lines: string[] = [];

  lines.push('# Project Architecture — Auto-Generated by MAOS Brain');
  lines.push('');
  lines.push(`> Generated: ${brain.generatedAt}`);
  lines.push(`> Files: ${brain.totalFiles} | Size: ${formatBytes(brain.totalSize)}`);
  lines.push('');

  // Language breakdown
  lines.push('## Languages');
  lines.push('');
  const sortedLangs = Object.entries(brain.languages).sort((a, b) => b[1] - a[1]);
  for (const [lang, count] of sortedLangs) {
    const pct = ((count / brain.totalFiles) * 100).toFixed(1);
    lines.push(`- **${lang}**: ${count} files (${pct}%)`);
  }
  lines.push('');

  // Directory structure
  lines.push('## Directory Structure');
  lines.push('');
  lines.push('```');
  const sortedDirs = Object.keys(brain.structure).sort();
  for (const dir of sortedDirs) {
    const fileCount = brain.structure[dir].length;
    lines.push(`${dir}/ (${fileCount} files)`);
    // Show up to 5 files per dir
    const filesToShow = brain.structure[dir].slice(0, 5);
    for (const f of filesToShow) {
      lines.push(`  └─ ${f}`);
    }
    if (brain.structure[dir].length > 5) {
      lines.push(`  └─ ... +${brain.structure[dir].length - 5} more`);
    }
  }
  lines.push('```');
  lines.push('');

  // File categories
  lines.push('## File Categories');
  lines.push('');
  const categories: Record<string, number> = {};
  for (const f of brain.files) {
    const cat = f.category || 'other';
    categories[cat] = (categories[cat] || 0) + 1;
  }
  const sortedCats = Object.entries(categories).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedCats) {
    lines.push(`- **${cat}**: ${count} files`);
  }
  lines.push('');

  // Key files (largest files are usually important)
  lines.push('## Key Files (by size)');
  lines.push('');
  const topFiles = [...brain.files].sort((a, b) => b.size - a.size).slice(0, 10);
  for (const f of topFiles) {
    lines.push(`- \`${f.path}\` — ${formatBytes(f.size)} (${f.language})`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Save brain data to .maos/brain/
 */
export function saveBrain(projectRoot: string, brain: BrainData): void {
  const brainDir = path.join(projectRoot, '.maos', 'brain');
  if (!fs.existsSync(brainDir)) {
    fs.mkdirSync(brainDir, { recursive: true });
  }

  // Save file map
  fs.writeFileSync(
    path.join(brainDir, 'file-map.json'),
    JSON.stringify(brain, null, 2),
    'utf-8'
  );

  // Save architecture markdown
  const architectureMd = generateArchitectureMd(brain);
  fs.writeFileSync(
    path.join(brainDir, 'architecture.md'),
    architectureMd,
    'utf-8'
  );
}

/**
 * Load brain data from .maos/brain/
 */
export function loadBrain(projectRoot: string): BrainData | null {
  const filePath = path.join(projectRoot, '.maos', 'brain', 'file-map.json');
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Generate a compact context string for injecting into agent system prompts.
 * This is the "brain injection" — gives the agent a structural understanding
 * of the codebase so it doesn't waste tokens on exploration.
 */
export function getBrainContext(projectRoot: string): string | null {
  const brain = loadBrain(projectRoot);
  if (!brain) return null;

  const lines: string[] = [];
  lines.push('## Project Context (auto-generated)');
  lines.push(`Files: ${brain.totalFiles} | Size: ${formatBytes(brain.totalSize)}`);
  lines.push('');

  // Compact language summary
  const topLangs = Object.entries(brain.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([l, c]) => `${l}(${c})`)
    .join(', ');
  lines.push(`Languages: ${topLangs}`);
  lines.push('');

  // Compact directory tree (top dirs only)
  lines.push('Structure:');
  const topDirs = Object.keys(brain.structure)
    .sort()
    .filter(d => d.split('/').length <= 3) // Only show top 3 levels
    .slice(0, 15);
  for (const dir of topDirs) {
    lines.push(`  ${dir}/ (${brain.structure[dir].length} files)`);
  }

  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function walkDir(dir: string, root: string, maxDepth = 5, depth = 0): string[] {
  if (depth >= maxDepth) return [];

  const SKIP = new Set(['node_modules', '.git', '.maos', 'dist', 'build', '.next', '__pycache__', '.venv', 'vendor']);
  const results: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);

      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, root, maxDepth, depth + 1));
      } else {
        results.push(relPath);
      }
    }
  } catch { /* skip unreadable dirs */ }

  return results;
}
