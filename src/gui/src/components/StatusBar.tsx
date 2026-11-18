import React, { useEffect, useState } from 'react';
import { apiAdapter } from '../api';
import type { ConnectionState } from '../api/event-client';

interface StatusBarProps {
  projectRoot?: string;
  activeStage?: string;
  apiEndpoint?: string;
  apiStatus?: string;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  projectRoot = 'UNVERIFIED',
  activeStage = 'NO ACTIVE RUN REPORTED',
  apiEndpoint = 'UNVERIFIED',
  apiStatus = 'CHECKING',
}) => {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [eventSeq, setEventSeq] = useState<number>(() => apiAdapter.getLastEventSeq());

  useEffect(() => {
    const unsubState = apiAdapter.subscribeConnectionState((state) => {
      setConnectionState(state);
    });

    const unsubEvents = apiAdapter.subscribeEvents((event) => {
      setEventSeq(event.sequence);
    });

    return () => {
      unsubState();
      unsubEvents();
    };
  }, []);

  return (
    <footer className="app-status-bar" role="contentinfo">
      <div className="status-section">
        <span className="status-item">
          <strong>PROJECT:</strong> {projectRoot}
        </span>
        <span className="status-item">
          <strong>API:</strong> {apiStatus}
        </span>
      </div>

      <div className="status-section">
        <span className="status-item">
          <strong>STAGE:</strong> {activeStage}
        </span>
        <span className="status-item">
          <strong>EVENTS:</strong> {connectionState.toUpperCase()} · #{String(eventSeq).padStart(4, '0')}
        </span>
      </div>

      <div className="status-section">
        <span className="status-item">
          <strong>API TARGET:</strong> {apiEndpoint}
        </span>
        <span className="kbd-hint">Alt+1..8: Views</span>
        <span className="kbd-hint">Ctrl+J: Cockpit</span>
        <button
          className="status-item"
          onClick={() => { window.location.hash = '#/settings'; }}
          title="Open Settings & Roles (Alt+8)"
          aria-label="Open Settings"
          data-testid="status-bar-settings-btn"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 6px',
            borderRadius: '3px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            color: 'inherit',
          }}
        >
          ⚙ Settings
        </button>
      </div>
    </footer>
  );
};
