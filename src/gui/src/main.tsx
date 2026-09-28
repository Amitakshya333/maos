import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ThemeProvider } from './components/ThemeContext';
import './styles/theme.css';
import './styles/layout.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('FATAL: Failed to find root element #root for MAOS GUI mount');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
