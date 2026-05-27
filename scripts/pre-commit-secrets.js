const { execSync } = require('child_process');
const fs = require('fs');

// ANSI color escape codes for beautiful terminal formatting (zero-dependency)
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

console.log(`${CYAN}${BOLD}🛡️  MAOS Secret Shield: Scanning staged changes...${RESET}`);

try {
  // 1. Check for staged .env files
  const stagedFiles = execSync('git diff --cached --name-only', { encoding: 'utf8' })
    .split('\n')
    .map(f => f.trim())
    .filter(Boolean);

  const blockedEnvFiles = stagedFiles.filter(file => {
    const baseName = file.split('/').pop();
    // Block .env, .env.local, .env.production, etc., but allow .env.example
    return baseName.startsWith('.env') && baseName !== '.env.example';
  });

  if (blockedEnvFiles.length > 0) {
    console.error(`\n${RED}${BOLD}❌ COMMIT BLOCKED: Sensitive Environment Files Staged!${RESET}`);
    console.error(`${YELLOW}You are attempting to commit the following git-ignored environment file(s):${RESET}`);
    blockedEnvFiles.forEach(file => console.error(`  - ${BOLD}${file}${RESET}`));
    console.error(`\n${CYAN}Action Required: Run the following command to unstage them:${RESET}`);
    console.error(`  ${BOLD}git restore --staged ${blockedEnvFiles.join(' ')}${RESET}\n`);
    process.exit(1);
  }

  // 2. Scan staged diff for secret key patterns
  const diff = execSync('git diff --cached', { encoding: 'utf8' });
  const lines = diff.split('\n');

  // Regex patterns to detect credentials
  const PATTERNS = [
    {
      name: 'Freemodel API Key',
      regex: /fe_oa_[a-f0-9]{32,64}/i,
    },
    {
      name: 'OpenAI API Key',
      regex: /sk-(proj-)?[a-zA-Z0-9]{32,64}/i,
    },
    {
      name: 'Obvious API Key Assignment',
      // Look for api_key = "value" or similar with a substantial string (16+ chars)
      regex: /api[-_]?key\s*=\s*['"]?[a-zA-Z0-9_\-]{16,}['"]?/i,
    },
    {
      name: 'Obvious Token Assignment',
      // Look for token = "value" or similar with a substantial string (16+ chars)
      regex: /token\s*=\s*['"]?[a-zA-Z0-9_\-]{16,}['"]?/i,
    }
  ];

  let secretsFound = 0;
  let currentFile = 'unknown';

  for (const line of lines) {
    // Keep track of which file we are currently scanning in the diff
    if (line.startsWith('+++ b/')) {
      currentFile = line.substring(6);
      continue;
    }

    // Only scan newly added lines (starting with '+') and exclude diff header lines
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const addedContent = line.substring(1); // strip the leading '+'

      for (const pattern of PATTERNS) {
        if (pattern.regex.test(addedContent)) {
          // Double-check: Make sure it's not just a placeholder we want to allow in .env.example
          const isPlaceholder = addedContent.includes('your-key-here') || addedContent.includes('your_key_here');
          if (isPlaceholder) continue;

          console.error(`\n${RED}${BOLD}❌ COMMIT BLOCKED: Potential Secret Detected!${RESET}`);
          console.error(`${YELLOW}File:${RESET} ${currentFile}`);
          console.error(`${YELLOW}Rule:${RESET} ${pattern.name}`);
          console.error(`${YELLOW}Line:${RESET} ${addedContent.trim()}`);
          console.error(`\n${CYAN}Please remove the sensitive credential before committing.${RESET}`);
          console.error(`${CYAN}If this is local development configuration, use a git-ignored '.env' file instead.${RESET}\n`);
          secretsFound++;
        }
      }
    }
  }

  if (secretsFound > 0) {
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}✅ Secret scan passed. No secrets detected!${RESET}\n`);
  process.exit(0);

} catch (error) {
  console.error(`${YELLOW}Warning: Secret scanning failed to execute cleanly: ${error.message}${RESET}`);
  console.error(`${YELLOW}Proceeding with commit to avoid blocking work...${RESET}`);
  process.exit(0);
}
