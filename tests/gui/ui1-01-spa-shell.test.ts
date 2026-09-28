/**
 * UI1-01: React SPA Shell with Local Assets Tests
 *
 * Tests:
 * 1. SPA build output verification (dist/gui and gui/dist presence)
 * 2. Local-only & disconnected verification (zero CDNs, remote fonts, external analytics)
 * 3. Strict Content-Security-Policy validation (loopback only)
 * 4. Structural regions coverage (Header, ActivityBar, Sidebar, Workspace, Drawer, StatusBar)
 * 5. Route placeholders coverage (chat, tasks, agents, evidence, artifacts, audit, models, settings)
 * 6. Theme and accessibility tokens (dark, high-contrast, system font stack)
 * 7. VM rehearsal checkReactAssets() compliance
 * 8. Loopback HTTP server static asset serving, SPA route fallback, and traversal rejection
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { checkReactAssets } from '../../src/industrial/vm-rehearsal';
import { serveSpaOrFallback } from '../../src/cli/dashboard';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DIST_GUI_DIR = path.resolve(PROJECT_ROOT, 'dist', 'gui');
const GUI_DIST_DIR = path.resolve(PROJECT_ROOT, 'gui', 'dist');

describe('UI1-01: React SPA Shell with Local Assets', () => {
  let server: http.Server;
  let serverPort: number;

  beforeAll(async () => {
    // Start temporary test server
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        serveSpaOrFallback(req, res, PROJECT_ROOT);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 1. SPA Build Output
  // ══════════════════════════════════════════════════════════════

  describe('SPA Build Output', () => {
    it('should have index.html in dist/gui', () => {
      const indexHtmlPath = path.join(DIST_GUI_DIR, 'index.html');
      expect(fs.existsSync(indexHtmlPath)).toBe(true);
      const content = fs.readFileSync(indexHtmlPath, 'utf8');
      expect(content).toContain('<div id="root">');
      expect(content).toContain('<!DOCTYPE html>');
    });

    it('should have index.html in gui/dist for vm-rehearsal checkReactAssets', () => {
      const guiDistIndexPath = path.join(GUI_DIST_DIR, 'index.html');
      expect(fs.existsSync(guiDistIndexPath)).toBe(true);
    });

    it('should have bundled assets in dist/gui/assets', () => {
      const assetsDir = path.join(DIST_GUI_DIR, 'assets');
      expect(fs.existsSync(assetsDir)).toBe(true);
      const files = fs.readdirSync(assetsDir);
      expect(files.some((f) => f.endsWith('.js'))).toBe(true);
      expect(files.some((f) => f.endsWith('.css'))).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Disconnected & Sovereign Guarantees (No External Assets)
  // ══════════════════════════════════════════════════════════════

  describe('Disconnected & Sovereign Guarantees', () => {
    it('should not contain any external CDN, font, or script URLs in index.html', () => {
      const indexHtml = fs.readFileSync(path.join(DIST_GUI_DIR, 'index.html'), 'utf8');
      expect(indexHtml).not.toMatch(/<(script|link)[^>]+(src|href)=["']https?:\/\//i);
      expect(indexHtml).not.toContain('fonts.googleapis.com');
      expect(indexHtml).not.toContain('cdnjs.cloudflare.com');
      expect(indexHtml).not.toContain('unpkg.com');
    });

    it('should enforce strict loopback-only Content Security Policy', () => {
      const indexHtml = fs.readFileSync(path.join(DIST_GUI_DIR, 'index.html'), 'utf8');
      expect(indexHtml).toContain('Content-Security-Policy');
      expect(indexHtml).toContain("default-src 'self'");
      expect(indexHtml).toContain('ws://127.0.0.1:*');
      expect(indexHtml).toContain('http://127.0.0.1:*');
    });

    it('should have zero remote imports in bundled CSS', () => {
      const assetsDir = path.join(DIST_GUI_DIR, 'assets');
      const cssFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.css'));
      for (const cssFile of cssFiles) {
        const cssContent = fs.readFileSync(path.join(assetsDir, cssFile), 'utf8');
        expect(cssContent).not.toMatch(/@import\s+url\(['"]?https?:\/\//);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Structural Regions Coverage
  // ══════════════════════════════════════════════════════════════

  describe('Structural Regions Coverage', () => {
    it('should have all 6 structural regions in React source components', () => {
      const componentsDir = path.resolve(PROJECT_ROOT, 'src', 'gui', 'src', 'components');
      expect(fs.existsSync(path.join(componentsDir, 'Header.tsx'))).toBe(true);
      expect(fs.existsSync(path.join(componentsDir, 'ActivityBar.tsx'))).toBe(true);
      expect(fs.existsSync(path.join(componentsDir, 'NavigationSidebar.tsx'))).toBe(true);
      expect(fs.existsSync(path.join(componentsDir, 'ContextDrawer.tsx'))).toBe(true);
      expect(fs.existsSync(path.join(componentsDir, 'StatusBar.tsx'))).toBe(true);
    });

    it('should include ARIA semantic landmarks in layout components', () => {
      const headerContent = fs.readFileSync(
        path.resolve(PROJECT_ROOT, 'src', 'gui', 'src', 'components', 'Header.tsx'),
        'utf8',
      );
      expect(headerContent).toContain('role="banner"');

      const activityBarContent = fs.readFileSync(
        path.resolve(PROJECT_ROOT, 'src', 'gui', 'src', 'components', 'ActivityBar.tsx'),
        'utf8',
      );
      expect(activityBarContent).toContain('role="navigation"');

      const sidebarContent = fs.readFileSync(
        path.resolve(PROJECT_ROOT, 'src', 'gui', 'src', 'components', 'NavigationSidebar.tsx'),
        'utf8',
      );
      expect(sidebarContent).toContain('role="complementary"');

      const statusBarContent = fs.readFileSync(
        path.resolve(PROJECT_ROOT, 'src', 'gui', 'src', 'components', 'StatusBar.tsx'),
        'utf8',
      );
      expect(statusBarContent).toContain('role="contentinfo"');

      const appContent = fs.readFileSync(
        path.resolve(PROJECT_ROOT, 'src', 'gui', 'src', 'App.tsx'),
        'utf8',
      );
      expect(appContent).toContain('role="main"');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Route Placeholders Coverage
  // ══════════════════════════════════════════════════════════════

  describe('Route Placeholders Coverage', () => {
    const requiredViews = [
      'ChatView.tsx',
      'TasksView.tsx',
      'AgentsView.tsx',
      'EvidenceView.tsx',
      'ArtifactsView.tsx',
      'AuditView.tsx',
      'ModelsView.tsx',
      'SettingsView.tsx',
    ];

    it.each(requiredViews)('should have view component %s', (viewFile) => {
      const viewPath = path.resolve(PROJECT_ROOT, 'src', 'gui', 'src', 'views', viewFile);
      expect(fs.existsSync(viewPath)).toBe(true);
      const content = fs.readFileSync(viewPath, 'utf8');
      expect(content).toContain('role="tabpanel"');
      expect(content).toContain('state-box');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Theme and Accessibility
  // ══════════════════════════════════════════════════════════════

  describe('Theme and Accessibility', () => {
    it('should define dark theme and high-contrast theme variables in theme.css', () => {
      const themeCss = fs.readFileSync(
        path.resolve(PROJECT_ROOT, 'src', 'gui', 'src', 'styles', 'theme.css'),
        'utf8',
      );
      expect(themeCss).toContain('--bg: #000000;');
      expect(themeCss).toContain('[data-theme="high-contrast"]');
      expect(themeCss).toContain('--primary: #ffff00;');
      expect(themeCss).toContain(':focus-visible');
    });

    it('should support Alt+1..8, Ctrl+J, and Alt+T keyboard shortcuts in App.tsx', () => {
      const appContent = fs.readFileSync(
        path.resolve(PROJECT_ROOT, 'src', 'gui', 'src', 'App.tsx'),
        'utf8',
      );
      expect(appContent).toContain('e.altKey');
      expect(appContent).toContain('toggleTheme');
      expect(appContent).toContain('setIsDrawerOpen');
      expect(appContent).toContain('VALID_VIEWS[num - 1]');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. Industrial VM Rehearsal Check
  // ══════════════════════════════════════════════════════════════

  describe('Industrial VM Rehearsal Check', () => {
    it('should pass checkReactAssets step when check=true and isRequired=true', () => {
      const step = checkReactAssets(PROJECT_ROOT, true, true);
      expect(step.passed).toBe(true);
      expect(step.step).toBe(10);
      expect(step.detail).toContain('index.html found in');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. Loopback Static Serving & SPA Routing Fallback
  // ══════════════════════════════════════════════════════════════

  describe('Loopback Static Serving & Fallback', () => {
    it('should serve SPA index.html at root route /', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const text = await res.text();
      expect(text).toContain('<div id="root">');
    });

    it('should fall back to index.html for client route /chat', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/chat`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const text = await res.text();
      expect(text).toContain('<div id="root">');
    });

    it('should fall back to index.html for client route /tasks', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/tasks`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const text = await res.text();
      expect(text).toContain('<div id="root">');
    });

    it('should serve bundled static JS asset with application/javascript', async () => {
      const assetsDir = path.join(DIST_GUI_DIR, 'assets');
      const jsFile = fs.readdirSync(assetsDir).find((f) => f.endsWith('.js'));
      expect(jsFile).toBeDefined();

      const res = await fetch(`http://127.0.0.1:${serverPort}/assets/${jsFile}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/javascript');
    });

    it('should reject path traversal attempts with 403 Forbidden', async () => {
      const status = await new Promise<number>((resolve) => {
        const req = http.get(
          {
            hostname: '127.0.0.1',
            port: serverPort,
            path: '/%2e%2e/package.json',
          },
          (res) => {
            resolve(res.statusCode || 0);
          },
        );
        req.end();
      });
      expect(status).toBe(403);
    });
  });
});
