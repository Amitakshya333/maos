import React, { useEffect, useState } from 'react';
import { useTheme } from './ThemeContext';
import { ShieldIcon, MoonIcon, SunIcon, ServerIcon } from './icons';
import { apiAdapter } from '../api';

interface HeaderProps {
  projectRoot?: string;
}

export const Header: React.FC<HeaderProps> = ({
  projectRoot = 'C:\\maos',
}) => {
  const { theme, toggleTheme } = useTheme();
  const [healthStatus, setHealthStatus] = useState<string>('CHECKING');
  const [modelStatus, setModelStatus] = useState<string>('MODEL: UNMEASURED');
  const [engineStatus, setEngineStatus] = useState<string>('ENGINE: UNMEASURED');

  useEffect(() => {
    let mounted = true;
    apiAdapter
      .getHealth()
      .then((health) => {
        if (!mounted) return;
        if (typeof health.status === 'string') {
          setHealthStatus(health.status.toUpperCase());
        }
        if (health.model && typeof (health.model as any).status === 'string') {
          setModelStatus(`MODEL: ${(health.model as any).status.toUpperCase()}`);
        }
        if (health.rust && typeof (health.rust as any).status === 'string') {
          setEngineStatus(`RUST: ${(health.rust as any).status.toUpperCase()}`);
        }
      })
      .catch(() => {
        // Safe disconnected fallback
        if (mounted) {
          setHealthStatus('API UNAVAILABLE');
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <header className="app-header" role="banner">
      <div className="header-brand">
        <div className="brand-icon" aria-label="MAOS Logo">M</div>
        <span className="brand-name">MAOS // MONOCHROME MISSION CONTROL</span>
        <span className="project-tag" title={`Project: ${projectRoot}`}>
          {projectRoot}
        </span>
      </div>

      <div className="header-status-group">
        {/* Local API connection status */}
        <div className="status-badge" title="Connected to the local MAOS API. Host-wide network egress is not measured here.">
          <span className="status-dot" />
          <ShieldIcon size={12} />
          <span>LOCAL API // EGRESS UNVERIFIED</span>
        </div>

        {/* Model Status */}
        <div className="status-badge" title="Local Model Residency">
          <span className="status-dot" />
          <span>{modelStatus}</span>
        </div>

        {/* Engine Status */}
        <div className="status-badge" title="Rust Deterministic Parity Engine">
          <span className="status-dot" />
          <ServerIcon size={12} />
          <span>{engineStatus}</span>
        </div>
      </div>

      <div className="header-actions">
        <button
          className="icon-btn"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'dark' ? 'High-Contrast' : 'Dark'} mode (Alt+T)`}
          aria-label="Toggle Theme"
        >
          {theme === 'dark' ? <MoonIcon size={16} /> : <SunIcon size={16} />}
        </button>
      </div>
    </header>
  );
};
