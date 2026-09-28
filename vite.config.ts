import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';
import * as fs from 'fs';

function copyToGuiDist() {
  return {
    name: 'copy-to-gui-dist',
    closeBundle() {
      const srcDir = path.resolve(__dirname, 'dist/gui');
      const targetDir = path.resolve(__dirname, 'gui/dist');
      if (fs.existsSync(srcDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.cpSync(srcDir, targetDir, { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyToGuiDist()],
  root: path.resolve(__dirname, 'src/gui'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/gui'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/gui/index.html'),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
  },
});
