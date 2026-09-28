const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(projectRoot, 'src', 'industrial', 'python');
const outputDir = path.join(projectRoot, 'dist', 'industrial', 'python');

if (!fs.existsSync(sourceDir)) {
  throw new Error(`Industrial Python source directory is missing: ${sourceDir}`);
}

fs.mkdirSync(outputDir, { recursive: true });
for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.py')) continue;
  fs.copyFileSync(path.join(sourceDir, entry.name), path.join(outputDir, entry.name));
}
