import React, { useEffect, useState } from 'react';
import { apiAdapter } from '../api';
import type { ConnectionState } from '../api/event-client';

interface StatusBarProps {
  projectRoot?: string;
  activeStage?: string;
  serverPort?: number;
  engineVerified?: boolean;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  projectRoot = 'C:\\maos',
  activeStage = 'IDLE // STANDBY',
  serverPort = 3847,
  engineVerified = true,
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
          <strong>STATUS:</strong> {connectionState.toUpperCase()}
        </span>
      </div>

      <div className="status-section">
        <span className="status-item">
          <strong>STAGE:</strong> {activeStage}
        </span>
        <span className="status-item">
          <strong>EVENT SEQ:</strong> #{String(eventSeq).padStart(4, '0')}
        </span>
      </div>

      <div className="status-section">
        <span className="status-item">
          <strong>HOST:</strong> 127.0.0.1:{serverPort}
        </span>
        <span className="status-item">
          <strong>RUST:</strong> {engineVerified ? 'SHA-256 VERIFIED' : 'UNVERIFIED'}
        </span>
        <span className="kbd-hint">Alt+1..8: Views</span>
        <span className="kbd-hint">Ctrl+J: Cockpit</span>
      </div>
    </footer>
  );
};
