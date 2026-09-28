import React from 'react';
import { ArtifactsIcon } from '../components/icons';

export const ArtifactsView: React.FC = () => {
  return (
    <div className="view-container" role="tabpanel" aria-label="Artifact Store View">
      <div className="view-header">
        <h1 className="view-title">Safe Artifact Store</h1>
        <p className="view-desc">
          Durably finalized output artifacts. Governed by atomic disk transitions, collision prevention, overwrite approval gates, and authoritative Rust SHA-256 hashes.
        </p>
      </div>

      <div className="state-box">
        <ArtifactsIcon size={40} className="state-icon" />
        <div className="state-title">No Artifacts Finalized</div>
        <p className="state-message">
          Consumes <code>GET /api/v1/artifacts</code> and <code>GET /api/v1/artifacts/:id/content</code>. Unapproved overwrites and path traversal attempts fail closed.
        </p>
        <span className="state-badge">CONTRACT: /api/v1/artifacts (F3-05)</span>
      </div>
    </div>
  );
};
