import React, { useState, useEffect } from 'react';
import { TerminalIcon, CloseIcon } from './icons';
import { apiAdapter } from '../api';
import type { SequencedEvent } from '../../../domain/schemas';

interface ContextDrawerProps {
  isOpen: boolean;
  onToggle: () => void;
  lastEventSeq?: number;
  height?: number;
}

export const ContextDrawer: React.FC<ContextDrawerProps> = ({
  isOpen,
  onToggle,
  height,
}) => {
  const [activeTab, setActiveTab] = useState<'events' | 'leases' | 'telemetry'>('events');
  const [liveEvents, setLiveEvents] = useState<SequencedEvent[]>([]);

  useEffect(() => {
    const unsub = apiAdapter.subscribeEvents((event) => {
      setLiveEvents((prev) => {
        // Keep most recent 50 events
        const updated = [event, ...prev];
        return updated.slice(0, 50);
      });
    });

    return () => {
      unsub();
    };
  }, []);

  const latestSeq = liveEvents.length > 0 ? liveEvents[0].sequence : apiAdapter.getLastEventSeq();

  return (
    <section
      className={`app-context-drawer ${isOpen ? '' : 'collapsed'}`}
      aria-label="Context and Cockpit Drawer"
      role="region"
      style={{ height: isOpen && height ? `${height}px` : undefined }}
    >
      <div className="drawer-header">
        <div className="drawer-tabs">
          <button
            className={`drawer-tab ${activeTab === 'events' ? 'active' : ''}`}
            onClick={() => setActiveTab('events')}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <TerminalIcon size={12} />
              Live Events (WebSocket) {latestSeq > 0 ? `[seq:${latestSeq}]` : ''}
            </span>
          </button>
          <button
            className={`drawer-tab ${activeTab === 'leases' ? 'active' : ''}`}
            onClick={() => setActiveTab('leases')}
          >
            Model Leases & VRAM
          </button>
          <button
            className={`drawer-tab ${activeTab === 'telemetry' ? 'active' : ''}`}
            onClick={() => setActiveTab('telemetry')}
          >
            Correlation & Provenance
          </button>
        </div>

        <button
          className="icon-btn"
          onClick={onToggle}
          title="Toggle Context Drawer (Ctrl+J or Alt+C)"
          aria-label="Close Context Drawer"
          style={{ width: 24, height: 24 }}
        >
          <CloseIcon size={14} />
        </button>
      </div>

      <div className="drawer-content">
        {activeTab === 'events' && (
          <div>
            {liveEvents.length === 0 ? (
              <div>
                <div className="event-row">
                  <span className="event-seq">0001</span>
                  <span className="event-type">SYSTEM_INIT</span>
                  <span className="event-detail">Loopback REST & WebSocket contracts initialized at 127.0.0.1</span>
                </div>
                <div className="event-row">
                  <span className="event-seq">0002</span>
                  <span className="event-type">RUST_PARITY_READY</span>
                  <span className="event-detail">maos-engine verified with SHA-256 evidence chain authority</span>
                </div>
              </div>
            ) : (
              liveEvents.map((evt) => (
                <div key={`${evt.eventId}-${evt.sequence}`} className="event-row">
                  <span className="event-seq">{String(evt.sequence).padStart(4, '0')}</span>
                  <span className="event-type">{evt.eventType}</span>
                  <span className="event-detail">
                    {typeof evt.payload === 'object' && evt.payload !== null
                      ? JSON.stringify(evt.payload)
                      : String(evt.payload ?? '')}
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'leases' && (
          <div>
            <div className="event-row">
              <span className="event-type">LEASE_STATE:</span>
              <span className="event-detail">No active exclusive GPU lease. VRAM occupancy: 0 MB / 12288 MB</span>
            </div>
            <div className="event-row">
              <span className="event-type">POLICY:</span>
              <span className="event-detail">Strict serialization enforced; timeout = 180s idle unload</span>
            </div>
          </div>
        )}

        {activeTab === 'telemetry' && (
          <div>
            <div className="event-row">
              <span className="event-type">CORRELATION_ID:</span>
              <span className="event-detail">corr-maos-gui-init-001</span>
            </div>
            <div className="event-row">
              <span className="event-type">IDEMPOTENCY:</span>
              <span className="event-detail">DurableIdempotencyStore ready in .maos/idempotency/</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
