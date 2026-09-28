import React, { useEffect, useState, useMemo } from 'react';
import { TasksIcon } from '../components/icons';
import { apiAdapter } from '../api';
import { useLayout } from '../components/LayoutContext';
import type { Task } from '../../../domain/schemas';

export const TasksView: React.FC = () => {
  const { role } = useLayout();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const fetchTasks = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiAdapter.getTasks();
      setTasks(result);
      if (result.length > 0 && !selectedTaskId) {
        setSelectedTaskId(result[0].id);
      }
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to fetch tasks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  const selectedTask = useMemo(() => {
    return tasks.find((t) => t.id === selectedTaskId) || null;
  }, [tasks, selectedTaskId]);

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      const matchStatus = statusFilter === 'all' || t.status === statusFilter;
      const matchAgent = agentFilter === 'all' || t.agent.toLowerCase().includes(agentFilter.toLowerCase());
      return matchStatus && matchAgent;
    });
  }, [tasks, statusFilter, agentFilter]);

  // Counts
  const counts = useMemo(() => {
    const res = { all: tasks.length, pending: 0, active: 0, done: 0, failed: 0 };
    for (const t of tasks) {
      if (t.status === 'pending') res.pending++;
      else if (t.status === 'active') res.active++;
      else if (t.status === 'done') res.done++;
      else if (t.status === 'failed') res.failed++;
    }
    return res;
  }, [tasks]);

  return (
    <div
      className="view-container"
      role="tabpanel"
      aria-label="Tasks & Runs View"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '16px' }}
    >
      {/* View Header */}
      <div className="view-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
        <div>
          <h1 className="view-title" style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>
            Tasks & Workflow Feed
          </h1>
          <p className="view-desc" style={{ fontSize: '13px', color: 'var(--text-dim, #888888)', margin: '4px 0 0 0' }}>
            Monitored task execution and multi-stage agentic workflows orchestrated by the typed application boundary.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="btn-secondary"
            onClick={() => {
              window.location.hash = '#/models';
            }}
            style={{ padding: '6px 14px', fontSize: '13px' }}
          >
            ⚡ Fair Queue Cockpit
          </button>
          <button className="btn-secondary" onClick={fetchTasks} disabled={loading} aria-label="Refresh tasks" style={{ padding: '6px 14px', fontSize: '13px' }}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Role-Specific Context Panel */}
      <div
        style={{
          padding: '8px 14px',
          backgroundColor: 'var(--bg-tertiary, #222222)',
          borderLeft: '4px solid var(--accent, #3b82f6)',
          borderRadius: '4px',
          marginBottom: '12px',
          fontSize: '12px',
          color: 'var(--text-secondary, #cccccc)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>
          <strong>Role Preset ({role.replace('_', ' ').toUpperCase()}):</strong>{' '}
          {role === 'inspector_analyst' && 'Prioritizing document extraction, sensor verification, and visual inspection tasks.'}
          {role === 'developer' && 'Prioritizing offline sandbox execution, test runs, and Python scripting tasks.'}
          {role === 'architect' && 'Prioritizing typed workflow DAGs, cycle analysis, and component dependencies.'}
          {role === 'manager_reviewer' && 'Prioritizing approval-gated deliverables, review notes, and final sign-offs.'}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--status-green, #4ade80)' }}>
          ● Server Queue Active (Survives Disconnect)
        </span>
      </div>

      {/* Filters Bar */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '12px',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['all', 'pending', 'active', 'done', 'failed'] as const).map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={statusFilter === st ? 'btn-primary' : 'btn-secondary'}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                textTransform: 'capitalize',
                backgroundColor: statusFilter === st ? 'var(--accent, #3b82f6)' : undefined,
              }}
            >
              {st} ({counts[st]})
            </button>
          ))}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-dim, #888888)' }}>Agent:</span>
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            style={{
              padding: '4px 8px',
              borderRadius: '4px',
              border: '1px solid var(--border-color, #444444)',
              backgroundColor: 'var(--bg-primary, #121212)',
              color: 'inherit',
              fontSize: '12px',
            }}
          >
            <option value="all">All Agents</option>
            <option value="ingest">INGEST_AGENT</option>
            <option value="analyst">ANALYST_AGENT</option>
            <option value="code">CODE_AGENT</option>
            <option value="report">REPORT_AGENT</option>
            <option value="supervisor">SUPERVISOR_AGENT</option>
          </select>
        </div>
      </div>

      {/* Main Dual-Pane Feed Workspace */}
      <div style={{ display: 'flex', flex: 1, gap: '16px', overflow: 'hidden' }}>
        {/* Left Task Table */}
        <div
          style={{
            flex: 1,
            backgroundColor: 'var(--bg-secondary, #1a1a1a)',
            borderRadius: '6px',
            border: '1px solid var(--border-color, #333333)',
            overflowY: 'auto',
          }}
        >
          {loading && tasks.length === 0 ? (
            <div className="state-box" style={{ margin: 'auto', padding: '60px 20px', textAlign: 'center', color: 'var(--text-dim, #888888)' }}>
              <div className="state-title">Loading Tasks...</div>
              <p className="state-message">Loading tasks from server queue...</p>
            </div>
          ) : error ? (
            <div className="state-box" style={{ margin: 'auto', padding: '40px 20px', textAlign: 'center', color: 'var(--status-red, #ef4444)' }}>
              <div className="state-title" style={{ color: 'var(--status-red, #ef4444)' }}>Error Loading Tasks</div>
              <p className="state-message">{error}</p>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="state-box" style={{ margin: 'auto', padding: '60px 20px', textAlign: 'center', color: 'var(--text-dim, #888888)' }}>
              <div style={{ opacity: 0.3, marginBottom: '8px' }}><TasksIcon size={40} /></div>
              <div className="state-title" style={{ fontSize: '14px', fontWeight: 500 }}>No Tasks in Feed</div>
              <p className="state-message" style={{ fontSize: '12px', margin: '4px 0 0 0' }}>
                Promote an exploration from chat or start a workflow to populate the task feed.
              </p>
            </div>
          ) : (
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }} aria-label="Tasks List">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color, #333333)', textAlign: 'left', color: 'var(--text-dim, #888888)' }}>
                  <th style={{ padding: '8px 12px' }}>ID</th>
                  <th style={{ padding: '8px 12px' }}>Description</th>
                  <th style={{ padding: '8px 12px' }}>Agent</th>
                  <th style={{ padding: '8px 12px' }}>Status</th>
                  <th style={{ padding: '8px 12px' }}>Complexity</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((t) => {
                  const isSelected = t.id === selectedTaskId;
                  return (
                    <tr
                      key={t.id}
                      onClick={() => setSelectedTaskId(t.id)}
                      style={{
                        cursor: 'pointer',
                        backgroundColor: isSelected ? 'var(--accent-dim, rgba(59, 130, 246, 0.15))' : 'transparent',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                      }}
                    >
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: 600 }}>{t.id}</td>
                      <td style={{ padding: '8px 12px', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.description}
                      </td>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: '12px' }}>{t.agent}</td>
                      <td style={{ padding: '8px 12px' }}>
                        <span
                          style={{
                            padding: '2px 8px',
                            borderRadius: '10px',
                            fontSize: '11px',
                            fontWeight: 600,
                            backgroundColor:
                              t.status === 'done'
                                ? 'rgba(74, 222, 128, 0.2)'
                                : t.status === 'active'
                                ? 'rgba(59, 130, 246, 0.2)'
                                : t.status === 'failed'
                                ? 'rgba(239, 68, 68, 0.2)'
                                : 'rgba(156, 163, 175, 0.2)',
                            color:
                              t.status === 'done'
                                ? '#4ade80'
                                : t.status === 'active'
                                ? '#60a5fa'
                                : t.status === 'failed'
                                ? '#f87171'
                                : '#9ca3af',
                          }}
                        >
                          {t.status.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{ fontSize: '11px', textTransform: 'capitalize' }}>{t.complexity}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Right Task Detail Inspector */}
        <div
          style={{
            width: '360px',
            backgroundColor: 'var(--bg-secondary, #1a1a1a)',
            borderRadius: '6px',
            border: '1px solid var(--border-color, #333333)',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
          }}
        >
          {selectedTask ? (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-dim, #888888)' }}>TASK INSPECTOR</span>
                <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{selectedTask.id}</span>
              </div>

              <h2 style={{ fontSize: '16px', fontWeight: 600, margin: '0 0 12px 0' }}>
                {selectedTask.description}
              </h2>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255, 255, 255, 0.06)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--text-dim, #888888)' }}>Status:</span>
                  <span style={{ fontWeight: 600 }}>{selectedTask.status.toUpperCase()}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255, 255, 255, 0.06)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--text-dim, #888888)' }}>Assigned Agent:</span>
                  <span style={{ fontFamily: 'monospace' }}>{selectedTask.agent}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255, 255, 255, 0.06)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--text-dim, #888888)' }}>Branch:</span>
                  <span style={{ fontFamily: 'monospace' }}>{selectedTask.branch || 'main'}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255, 255, 255, 0.06)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--text-dim, #888888)' }}>Complexity:</span>
                  <span style={{ textTransform: 'capitalize' }}>{selectedTask.complexity}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255, 255, 255, 0.06)', paddingBottom: '6px' }}>
                  <span style={{ color: 'var(--text-dim, #888888)' }}>Created At:</span>
                  <span>{new Date(selectedTask.createdAt).toLocaleString()}</span>
                </div>

                {selectedTask.requirements && (
                  <div style={{ marginTop: '8px', padding: '10px', backgroundColor: 'var(--bg-tertiary, #222222)', borderRadius: '4px' }}>
                    <div style={{ fontWeight: 600, marginBottom: '6px' }}>Task Requirements:</div>
                    <div style={{ color: 'var(--text-dim, #aaaaaa)', lineHeight: '1.4' }}>
                      Modalities: {selectedTask.requirements.modalities?.join(', ') || 'text'}<br />
                      Non-Degradation: Enforced by configured policy
                    </div>
                  </div>
                )}

                <div style={{ marginTop: '12px', padding: '10px', backgroundColor: 'rgba(59, 130, 246, 0.1)', border: '1px solid var(--accent, #3b82f6)', borderRadius: '4px' }}>
                  <div style={{ fontWeight: 600, color: 'var(--accent, #60a5fa)', marginBottom: '4px' }}>
                    Offline Queue Persistence
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary, #cccccc)', lineHeight: '1.4' }}>
                    This task runs in the MAOS background queue. Closing or refreshing the browser window does not interrupt execution.
                  </div>
                </div>

                <div style={{ marginTop: '14px' }}>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      window.location.hash = '#/chat';
                    }}
                    style={{ width: '100%', padding: '8px', fontSize: '12px' }}
                  >
                    💬 Switch to Chat View
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--text-dim, #888888)', fontSize: '13px' }}>
              Select a task from the list to inspect details.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
