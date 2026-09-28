import React from 'react';
import { CockpitView } from './CockpitView';

export const AgentsView: React.FC = () => {
  return (
    <div role="tabpanel" aria-label="Agents & Cockpit View">
      <CockpitView />
      <div className="state-box" style={{ display: 'none' }} aria-hidden="true" />
    </div>
  );
};
