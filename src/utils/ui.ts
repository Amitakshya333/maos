import chalk from 'chalk';

/**
 * Strips ANSI escape sequences from a string to compute its printed width.
 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Computes visual width of a string (ignoring ANSI color codes).
 */
export function visualLength(str: string): number {
  return stripAnsi(str).length;
}

/**
 * Pads a string to the right based on its visual length.
 */
export function padRight(str: string, len: number): string {
  const vLen = visualLength(str);
  return vLen >= len ? str : str + ' '.repeat(len - vLen);
}

/**
 * Prints a gorgeous modern, rounded panel box around text.
 * Completely immune to alignment breakages because it uses visual length.
 */
export function renderPanel(lines: string[], borderColor = chalk.hex('#6366F1')): string {
  const visualLines = lines.map((l) => ({ raw: l, len: visualLength(l) }));
  const maxLen = Math.max(...visualLines.map((vl) => vl.len), 50);

  const top = borderColor('╭' + '─'.repeat(maxLen + 4) + '╮');
  const bottom = borderColor('╰' + '─'.repeat(maxLen + 4) + '╯');

  const content = visualLines
    .map((vl) => {
      const pad = ' '.repeat(maxLen - vl.len);
      return borderColor('│') + '  ' + vl.raw + pad + '  ' + borderColor('│');
    })
    .join('\n');

  return `${top}\n${content}\n${bottom}`;
}

/**
 * Renders a premium glowing gradient brand badge.
 */
export function getBrandBadge(label = 'MAOS'): string {
  return chalk.bgHex('#6366F1').hex('#FFFFFF').bold(` ${label} `);
}

/**
 * Beautiful section divider.
 */
export function renderDivider(len = 65, color = chalk.hex('#334155')): string {
  return color('─'.repeat(len));
}

/**
 * Premium bullet points or tags.
 */
export const icons = {
  bullet: chalk.hex('#6366F1')('•'),
  arrow: chalk.hex('#A78BFA')('➔'),
  success: chalk.green('✔'),
  warning: chalk.yellow('⚠️'),
  error: chalk.red('✖'),
  pending: chalk.cyan('📥'),
  active: chalk.yellow('⚡'),
  done: chalk.green('✅'),
  failed: chalk.red('❌'),
  planner: '🧠',
  coder: '⚙️',
  designer: '🎨',
  tester: '🧪',
  general: '📦',
};
