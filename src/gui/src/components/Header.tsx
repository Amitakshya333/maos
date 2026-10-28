import React from 'react';
import { useTheme } from './ThemeContext';
import { ShieldIcon, MoonIcon, SunIcon, ServerIcon } from './icons';

interface HeaderProps {
  projectRoot?: string;
  apiStatus?: string;
  modelStatus?: string;
  engineStatus?: string;
  sessionStatus?: string;
}

function statusDotTone(status: string): string {
  if (status.endsWith('HEALTHY') || status.endsWith('AVAILABLE')) return '';
  return status.endsWith('UNAVAILABLE') || status.endsWith('UNHEALTHY') ? 'red' : 'amber';
}

export const Header: React.FC<HeaderProps> = ({
  projectRoot = 'UNVERIFIED',
  apiStatus = 'CHECKING',
  modelStatus = 'MODEL: NOT REPORTED',
  engineStatus = 'ENGINE: NOT REPORTED',
  sessionStatus = 'NOT INITIALIZED',
}) => {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="app-header" role="banner">
      <div className="header-brand">
        <div className="brand-icon" aria-label="MAOS Logo">M</div>
        <span className="brand-name">MAOS // MONOCHROME MISSION CONTROL</span>
        <span className="project-tag" title={`Verified project context: ${projectRoot}`}>
          {projectRoot}
        </span>
      </div>

      <div className="header-status-group">
        <div
          className="status-badge"
          title="Status from the local API health endpoint; host-wide network egress is not measured here."
        >
          <span className={`status-dot ${statusDotTone(apiStatus)}`} />
          <ShieldIcon size={12} />
          <span>API: {apiStatus}</span>
        </div>

        <div
          className="status-badge"
          title="In-memory browser token presence only; a protected API request confirms whether it is still valid."
        >
          <span>SESSION TOKEN: {sessionStatus}</span>
        </div>

        <div className="status-badge" title="Model status is shown only when the API reports it.">
          <span className={`status-dot ${statusDotTone(modelStatus)}`} />
          <span>{modelStatus}</span>
        </div>

        <div className="status-badge" title="Engine status is shown only when the API reports it.">
          <span className={`status-dot ${statusDotTone(engineStatus)}`} />
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
