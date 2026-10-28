import React from 'react';
import ReactDOM from 'react-dom/client';
import { apiAdapter } from './api';
import { App } from './App';
import { ThemeProvider } from './components/ThemeContext';
import './styles/theme.css';
import './styles/layout.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('FATAL: Failed to find root element #root for MAOS GUI mount');
}

async function mount(element: HTMLElement): Promise<void> {
  try {
    if (!window.maosNative) {
      throw new Error('PRIVATE_LAUNCHER_REQUIRED: Start MAOS through the desktop launcher.');
    }
    const launcherSession = await window.maosNative.initialize();
    apiAdapter.initializeFromLauncher(launcherSession);
    apiAdapter.start();
    window.addEventListener('pagehide', () => apiAdapter.stop(), { once: true });
    ReactDOM.createRoot(element).render(
      <React.StrictMode>
        <ThemeProvider>
          <App industrialDemo={launcherSession.projectId === 'maos-industrial-demo'} />
        </ThemeProvider>
      </React.StrictMode>,
    );
  } catch (error) {
    element.textContent = error instanceof Error ? error.message : 'Secure launcher initialization failed.';
  }
}

void mount(rootElement);
