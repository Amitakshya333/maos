import React, { useState, useEffect, useRef } from 'react';
import { ChatIcon, TasksIcon } from '../components/icons';
import { apiAdapter } from '../api';
import type { Conversation, Message } from '../../../domain/schemas';
import type { ChatAttachment, PromoteToTaskInput } from '../../../domain/conversation';
import type { OperationalMode, CitedClaim } from '../../../domain/evidence-mode';
import type { ActiveModelIdentity } from '../../../domain/model-switch';
import type { ModelRegistration } from '../../../domain/model-manifest';
import { FilePickerModal } from '../components/FilePickerModal';

export const ChatView: React.FC = () => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [activeModel, setActiveModel] = useState<ActiveModelIdentity | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelRegistration[]>([]);
  const [chatSwitchError, setChatSwitchError] = useState<string | null>(null);
  const [chatConfirmPrompt, setChatConfirmPrompt] = useState<{ targetModelId: string; message: string } | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [sending, setSending] = useState<boolean>(false);
  const [inputContent, setInputContent] = useState<string>('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isFilePickerOpen, setIsFilePickerOpen] = useState<boolean>(false);
  const [isDowngradeModalOpen, setIsDowngradeModalOpen] = useState<boolean>(false);
  const [pendingMode, setPendingMode] = useState<OperationalMode | null>(null);
  const [promoteModalData, setPromoteModalData] = useState<{
    isOpen: boolean;
    description: string;
    agent: string;
    complexity: 'low' | 'medium' | 'high';
    messageId?: string;
    allowUnreviewedBrainstorm?: boolean;
  }>({
    isOpen: false,
    description: '',
    agent: 'supervisor_agent',
    complexity: 'medium',
    allowUnreviewedBrainstorm: false,
  });
  const [promotionNotice, setPromotionNotice] = useState<{ taskId: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load conversations
  const loadConversations = async () => {
    try {
      const list = await apiAdapter.getConversations();
      setConversations(list);
      if (list.length > 0 && !activeConvId) {
        setActiveConvId(list[0].id);
      }
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to load conversations');
    } finally {
      setLoading(false);
    }
  };

  const loadModels = async () => {
    try {
      const [identity, modelsRes] = await Promise.all([
        apiAdapter.getActiveModelIdentity().catch(() => null),
        apiAdapter.getModels().catch(() => null),
      ]);
      if (identity) setActiveModel(identity);
      if (modelsRes?.registeredModels && Array.isArray(modelsRes.registeredModels)) {
        setAvailableModels(modelsRes.registeredModels);
      }
    } catch {}
  };

  useEffect(() => {
    loadConversations();
    loadModels();
    const interval = setInterval(loadModels, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleChatModelSelect = async (targetId: string, preConfirmed = false) => {
    setChatSwitchError(null);
    if (!targetId || targetId === activeModel?.modelId) return;

    try {
      const res = await apiAdapter.switchModel({
        targetModelId: targetId,
        actor: 'chat_user',
        reason: 'Selected model override in chat',
        conversationId: activeConvId || undefined,
        confirmed: preConfirmed,
      });

      if (res.status === 'CONFIRMATION_REQUIRED') {
        setChatConfirmPrompt({ targetModelId: targetId, message: res.message });
      } else {
        setChatConfirmPrompt(null);
        await loadModels();
      }
    } catch (err: unknown) {
      setChatSwitchError((err as Error).message || 'Failed to switch model in chat');
    }
  };

  // Fetch active conversation details
  useEffect(() => {
    if (!activeConvId) {
      setActiveConv(null);
      return;
    }
    const fetchActive = async () => {
      try {
        const conv = await apiAdapter.getConversation(activeConvId);
        setActiveConv(conv);
      } catch (err: unknown) {
        setError((err as Error).message || `Failed to fetch conversation ${activeConvId}`);
      }
    };
    fetchActive();
  }, [activeConvId]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConv?.messages]);

  const handleCreateSession = async () => {
    setError(null);
    try {
      const newConv = await apiAdapter.createConversation({
        projectId: 'default-project',
        agentId: 'sovereign_chat_agent',
      });
      setConversations((prev) => [newConv, ...prev]);
      setActiveConvId(newConv.id);
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to create conversation');
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputContent.trim() && attachments.length === 0) return;
    if (!activeConvId) return;

    setSending(true);
    setError(null);
    try {
      const userMsg = await apiAdapter.addMessage(activeConvId, {
        role: 'user',
        content: inputContent.trim() || null,
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      // Update state locally with user message
      const updatedMessages = activeConv ? [...activeConv.messages, userMsg] : [userMsg];
      if (activeConv) {
        setActiveConv({
          ...activeConv,
          messages: updatedMessages,
        });
      }

      setInputContent('');
      setAttachments([]);

      // Call real model-backed inference endpoint
      try {
        const history = updatedMessages
          .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
          .map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content || '',
          }));

        const response = await apiAdapter.chatCompletion(activeConvId, history);

        const assistantMsg = await apiAdapter.addMessage(activeConvId, {
          role: 'assistant',
          content: response.message.content,
          isModelGenerated: true,
          verifiedAgainstData: false,
          tokenUsage: response.usage,
        });

        setActiveConv((prev) => prev ? {
          ...prev,
          messages: [...prev.messages, assistantMsg],
        } : null);
      } catch (inferErr: any) {
        const errorMsg = inferErr.message || 'Model inference failed';
        if (errorMsg.includes('MODEL_SERVER_UNAVAILABLE') || inferErr.code === 'MODEL_SERVER_UNAVAILABLE') {
          setError(
            'Local model server unavailable. Ensure the model server is running at http://127.0.0.1:8000 (scripts/huggingface-openai-server.py).'
          );
        } else {
          setError(`Inference error: ${errorMsg}`);
        }
      } finally {
        setSending(false);
      }

    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to send message');
      setSending(false);
    }
  };

  const openPromoteModal = (message?: Message) => {
    const desc = message?.content || (activeConv?.messages.slice(-1)[0]?.content) || 'Analyze and execute industrial workflow';
    setPromoteModalData({
      isOpen: true,
      description: desc,
      agent: activeConv?.agentId || 'supervisor_agent',
      complexity: 'medium',
      messageId: message?.id,
      allowUnreviewedBrainstorm: false,
    });
  };

  const handleModeSelect = async (targetMode: OperationalMode) => {
    if (!activeConvId || !activeConv) return;
    const currentMode = activeConv.mode || 'evidence';
    if (currentMode === targetMode) return;

    if (currentMode === 'evidence' && targetMode === 'brainstorm') {
      setPendingMode('brainstorm');
      setIsDowngradeModalOpen(true);
      return;
    }

    try {
      const updated = await apiAdapter.updateConversationMode(activeConvId, targetMode, false);
      setActiveConv(updated);
      setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to update conversation mode');
    }
  };

  const handleConfirmDowngrade = async () => {
    if (!activeConvId || !pendingMode) return;
    try {
      const updated = await apiAdapter.updateConversationMode(activeConvId, pendingMode, true);
      setActiveConv(updated);
      setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setIsDowngradeModalOpen(false);
      setPendingMode(null);
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to downgrade conversation mode');
    }
  };

  const handleTogglePin = async () => {
    if (!activeConvId || !activeConv) return;
    try {
      const updated = await apiAdapter.setConversationPinned(activeConvId, !activeConv.pinned);
      setActiveConv(updated);
      setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to update pin status');
    }
  };

  const handlePromoteConfirm = async () => {
    if (!activeConvId) return;
    try {
      const res = await apiAdapter.promoteToTask(activeConvId, {
        conversationId: activeConvId,
        description: promoteModalData.description,
        agent: promoteModalData.agent,
        complexity: promoteModalData.complexity,
        attachments: attachments.length > 0 ? attachments : undefined,
        allowUnreviewedBrainstorm: promoteModalData.allowUnreviewedBrainstorm,
      });

      setPromotionNotice({
        taskId: res.task.id,
        message: `Task successfully orchestrated with ID "${res.task.id}". It is queued in background and survives UI disconnects.`,
      });
      setActiveConv(res.conversation);
      setPromoteModalData((prev) => ({ ...prev, isOpen: false }));
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to promote conversation to task');
    }
  };

  return (
    <div
      className="view-container"
      role="tabpanel"
      aria-label="Chat & Conversations View"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '16px' }}
    >
      {/* Top Header */}
      <div className="view-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <h1 className="view-title" style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>
            Chat & Interactive Exploration
          </h1>
          <p className="view-desc" style={{ fontSize: '13px', color: 'var(--text-dim, #888888)', margin: '4px 0 0 0' }}>
            Local interactive sessions with open-weight models. Exploration remains purely conversational until explicitly promoted to a tracked task.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="btn-secondary"
            onClick={handleCreateSession}
            aria-label="New Session"
            style={{ padding: '6px 14px', fontSize: '13px' }}
          >
            + New Session
          </button>
          {activeConv && (
            <button
              className="btn-primary"
              onClick={() => openPromoteModal()}
              aria-label="Promote to Task"
              style={{ padding: '6px 14px', fontSize: '13px', backgroundColor: 'var(--accent, #3b82f6)' }}
            >
              ⚡ Promote to Task
            </button>
          )}
        </div>
      </div>

      {/* Safety Notice Banner */}
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
          🛡️ <strong>Exploration Boundary:</strong> Free-form chat exploration does not touch project files or spawn background tasks automatically. Attachments are strictly confined to project root (max 50MB).
        </span>
        {activeConv?.taskId && (
          <span style={{ color: 'var(--status-green, #4ade80)', fontWeight: 600 }}>
            Linked Task: {activeConv.taskId}
          </span>
        )}
      </div>

      {/* Promotion Notification Banner */}
      {promotionNotice && (
        <div
          style={{
            padding: '10px 16px',
            backgroundColor: 'rgba(74, 222, 128, 0.15)',
            border: '1px solid var(--status-green, #4ade80)',
            borderRadius: '4px',
            marginBottom: '12px',
            fontSize: '13px',
            color: 'var(--status-green, #4ade80)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>✅ {promotionNotice.message}</span>
          <button
            className="btn-secondary"
            onClick={() => {
              window.location.hash = '#/tasks';
            }}
            style={{ padding: '4px 10px', fontSize: '12px' }}
          >
            View in Task Feed →
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: '10px 14px',
            backgroundColor: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid var(--status-red, #ef4444)',
            borderRadius: '4px',
            marginBottom: '12px',
            fontSize: '12px',
            color: 'var(--status-red, #ef4444)',
          }}
        >
          {error}
        </div>
      )}

      {/* Main Chat Workspace */}
      <div style={{ display: 'flex', flex: 1, gap: '16px', overflow: 'hidden' }}>
        {/* Session Selector Sidebar */}
        <div
          style={{
            width: '240px',
            backgroundColor: 'var(--bg-secondary, #1a1a1a)',
            borderRadius: '6px',
            border: '1px solid var(--border-color, #333333)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-color, #333333)', fontWeight: 600, fontSize: '13px' }}>
            Sessions ({conversations.length})
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
            {conversations.map((c) => (
              <div
                key={c.id}
                onClick={() => setActiveConvId(c.id)}
                style={{
                  padding: '8px 10px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  marginBottom: '4px',
                  backgroundColor: c.id === activeConvId ? 'var(--accent-dim, rgba(59, 130, 246, 0.2))' : 'transparent',
                  border: c.id === activeConvId ? '1px solid var(--accent, #3b82f6)' : '1px solid transparent',
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{c.messages.length > 0 ? (c.messages[0].content?.substring(0, 24) || 'Interactive Session') : 'New Session'}</span>
                  {c.pinned && <span title="Pinned session" style={{ fontSize: '12px' }}>📌</span>}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim, #888888)', display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                  <span>{c.mode === 'brainstorm' ? '💡 Brainstorm' : '🛡️ Industrial'} • {c.messages.length} msgs</span>
                  <span>{new Date(c.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Conversation Thread & Input Area */}
        <div
          style={{
            flex: 1,
            backgroundColor: 'var(--bg-secondary, #1a1a1a)',
            borderRadius: '6px',
            border: '1px solid var(--border-color, #333333)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Thread Header */}
          <div
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--border-color, #333333)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, fontSize: '14px' }}>
                {activeConv ? activeConv.id : 'No Session Selected'}
              </span>
              {activeConv && (
                <>
                  <span
                    style={{
                      marginLeft: '10px',
                      fontSize: '11px',
                      backgroundColor: 'var(--bg-tertiary, #2c2c2c)',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      color: 'var(--text-dim, #aaaaaa)',
                    }}
                  >
                    Agent: {activeConv.agentId}
                  </span>

                  <button
                    onClick={() => handleModeSelect(activeConv.mode === 'brainstorm' ? 'evidence' : 'brainstorm')}
                    data-testid="mode-toggle-btn"
                    title="Click to toggle between Industrial Evidence Mode and Brainstorm Mode"
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      border: '1px solid',
                      cursor: 'pointer',
                      backgroundColor: activeConv.mode === 'brainstorm' ? 'rgba(234, 179, 8, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                      borderColor: activeConv.mode === 'brainstorm' ? '#eab308' : '#3b82f6',
                      color: activeConv.mode === 'brainstorm' ? '#eab308' : '#3b82f6',
                      fontWeight: 600,
                      marginLeft: '10px',
                    }}
                  >
                    {activeConv.mode === 'brainstorm' ? '💡 Brainstorm Mode' : '🛡️ Industrial Evidence Mode'}
                  </button>

                  <button
                    onClick={handleTogglePin}
                    data-testid="conv-pin-btn"
                    title={activeConv.pinned ? 'Pinned (Protected from retention purge)' : 'Unpinned (Subject to retention purge)'}
                    style={{
                      fontSize: '13px',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      marginLeft: '8px',
                      padding: '2px 4px',
                    }}
                  >
                    {activeConv.pinned ? '📌' : '📍'}
                  </button>
                </>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: activeModel?.device === 'cuda' ? '#3b82f6' : 'var(--text-dim, #888888)',
                  backgroundColor: 'var(--bg-tertiary, #2c2c2c)',
                  padding: '2px 8px',
                  borderRadius: '4px',
                }}
                data-testid="chat-active-model-badge"
              >
                {activeModel?.device ? activeModel.device.toUpperCase() : 'LOCAL'}: {activeModel?.modelId || 'None'}
              </span>

              {availableModels.length > 0 && (
                <select
                  value={activeModel?.modelId || ''}
                  onChange={(e) => handleChatModelSelect(e.target.value)}
                  style={{
                    fontSize: '11px',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    background: 'var(--bg-tertiary, #2c2c2c)',
                    border: '1px solid var(--border-color, #333333)',
                    color: 'var(--text-main, #ffffff)',
                    cursor: 'pointer',
                  }}
                  data-testid="chat-model-selector"
                  aria-label="Select Model"
                >
                  {availableModels.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {m.modelName || m.modelId} ({m.device.toUpperCase()})
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Error Banner */}
          {error && (
            <div
              style={{
                padding: '8px 14px',
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                borderBottom: '1px solid var(--status-red, #ef4444)',
                color: 'var(--status-red, #ef4444)',
                fontSize: '12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
              data-testid="chat-error-banner"
            >
              <span>✗ {error}</span>
              <button
                onClick={() => setError(null)}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '11px' }}
              >
                ✕
              </button>
            </div>
          )}

          {/* Model Switch Error / Confirmation Banners in Chat */}
          {chatSwitchError && (
            <div
              style={{
                padding: '8px 14px',
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                borderBottom: '1px solid var(--status-red, #ef4444)',
                color: 'var(--status-red, #ef4444)',
                fontSize: '12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
              data-testid="chat-switch-error-banner"
            >
              <span>✗ {chatSwitchError}</span>
              <button
                onClick={() => setChatSwitchError(null)}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '11px' }}
              >
                ✕
              </button>
            </div>
          )}

          {chatConfirmPrompt && (
            <div
              style={{
                padding: '10px 14px',
                backgroundColor: 'rgba(245, 158, 11, 0.15)',
                borderBottom: '1px solid var(--status-amber, #f59e0b)',
                fontSize: '12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
              data-testid="chat-confirm-prompt-banner"
            >
              <span>⚠️ {chatConfirmPrompt.message}</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="btn-primary"
                  onClick={() => handleChatModelSelect(chatConfirmPrompt.targetModelId, true)}
                  style={{ fontSize: '11px', padding: '3px 8px', backgroundColor: 'var(--status-amber, #f59e0b)', color: '#000' }}
                  data-testid="chat-confirm-switch-btn"
                >
                  Confirm & Unload
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => setChatConfirmPrompt(null)}
                  style={{ fontSize: '11px', padding: '3px 8px' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Message List */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {!activeConv || activeConv.messages.length === 0 ? (
              <div className="state-box" style={{ margin: 'auto', padding: '60px 20px', textAlign: 'center', color: 'var(--text-dim, #888888)' }}>
                <div style={{ opacity: 0.4, marginBottom: '12px' }}><ChatIcon size={44} /></div>
                <div className="state-title" style={{ fontSize: '15px', fontWeight: 500 }}>Sovereign Local Chat Ready</div>
                <p className="state-message" style={{ fontSize: '13px', maxWidth: '420px', margin: '6px auto 0 auto' }}>
                  Ask questions, explore ideas, or attach confidential files from the project root. Messages will not create tasks until you click Promote.
                </p>
              </div>
            ) : (
              activeConv.messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '80%',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '4px',
                      fontSize: '11px',
                      color: 'var(--text-dim, #888888)',
                    }}
                  >
                    <span
                      style={{
                        textTransform: 'uppercase',
                        fontWeight: 600,
                        color: m.role === 'user' ? 'var(--accent, #3b82f6)' : 'var(--status-green, #4ade80)',
                      }}
                    >
                      {m.role}
                    </span>
                    <span>{new Date(m.timestamp).toLocaleTimeString()}</span>
                  </div>

                  <div
                    style={{
                      padding: '10px 14px',
                      borderRadius: '8px',
                      backgroundColor: m.role === 'user' ? 'var(--accent-dim, rgba(59, 130, 246, 0.15))' : 'var(--bg-tertiary, #262626)',
                      border: m.role === 'user' ? '1px solid var(--accent, #3b82f6)' : '1px solid var(--border-color, #3a3a3a)',
                      fontSize: '13px',
                      lineHeight: '1.5',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {/* UI1-10: Unverified Model Prose Warning Badge */}
                    {m.isModelGenerated && !m.verifiedAgainstData && (
                      <div
                        data-testid="unverified-prose-badge"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '3px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          backgroundColor: 'rgba(234, 179, 8, 0.15)',
                          color: '#eab308',
                          border: '1px solid rgba(234, 179, 8, 0.35)',
                          marginBottom: '8px',
                          fontWeight: 500,
                        }}
                      >
                        <span>⚠️</span>
                        <span>Unverified Model Prose — Citation Required in Industrial Mode</span>
                      </div>
                    )}

                    <div>{m.content}</div>

                    {/* UI1-10: Cryptographic Cited Claims Display */}
                    {m.claims && Array.isArray(m.claims) && m.claims.length > 0 && (
                      <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: '#60a5fa', marginBottom: '6px' }}>
                          Verified Evidence Claims ({m.claims.length}):
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {m.claims.map((claim: any) => (
                            <div
                              key={claim.id}
                              data-testid="cited-claim-item"
                              style={{
                                fontSize: '11px',
                                backgroundColor: 'rgba(0, 0, 0, 0.3)',
                                padding: '6px 8px',
                                borderRadius: '4px',
                                border: '1px solid rgba(255, 255, 255, 0.1)',
                              }}
                            >
                              <div style={{ fontWeight: 500 }}>{claim.statement}</div>
                              {claim.citations && Array.isArray(claim.citations) && claim.citations.map((c: any, cIdx: number) => (
                                <div key={cIdx} style={{ fontSize: '10px', color: 'var(--text-dim, #888)', marginTop: '4px' }}>
                                  <span>📎 {c.sourcePath}</span>
                                  <span style={{ marginLeft: '6px' }}>SHA-256: <code>{c.sourceHash?.substring(0, 8)}...</code></span>
                                  {c.snippet && <div style={{ fontStyle: 'italic', marginTop: '2px', color: '#ccc' }}>"{c.snippet}"</div>}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {m.attachments && m.attachments.length > 0 && (
                      <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px' }}>Attached Project Evidence:</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {m.attachments.map((att) => (
                            <span
                              key={att.id}
                              style={{
                                fontSize: '11px',
                                backgroundColor: 'rgba(0, 0, 0, 0.3)',
                                padding: '3px 8px',
                                borderRadius: '4px',
                                border: '1px solid rgba(255, 255, 255, 0.15)',
                              }}
                            >
                              📄 {att.name} ({(att.sizeBytes / 1024).toFixed(0)} KB)
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {m.role === 'user' && (
                    <button
                      onClick={() => openPromoteModal(m)}
                      style={{
                        alignSelf: 'flex-end',
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-dim, #888888)',
                        fontSize: '11px',
                        cursor: 'pointer',
                        marginTop: '4px',
                        padding: '2px 6px',
                      }}
                      title="Promote this message into a tracked task"
                    >
                      ⚡ Promote to Task
                    </button>
                  )}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Attachment Tray */}
          {attachments.length > 0 && (
            <div
              style={{
                padding: '8px 16px',
                borderTop: '1px solid var(--border-color, #333333)',
                backgroundColor: 'var(--bg-tertiary, #202020)',
                display: 'flex',
                gap: '8px',
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-dim, #888888)' }}>
                Pending Attachments ({attachments.length}):
              </span>
              {attachments.map((att) => (
                <div
                  key={att.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '3px 8px',
                    borderRadius: '4px',
                    backgroundColor: 'rgba(59, 130, 246, 0.15)',
                    border: '1px solid var(--accent, #3b82f6)',
                    fontSize: '11px',
                  }}
                >
                  <span>📄 {att.name}</span>
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                    style={{ background: 'none', border: 'none', color: '#ff5555', cursor: 'pointer', fontWeight: 600 }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Message Input Box */}
          <form
            onSubmit={handleSendMessage}
            style={{
              padding: '12px 16px',
              borderTop: '1px solid var(--border-color, #333333)',
              display: 'flex',
              gap: '10px',
              alignItems: 'center',
            }}
          >
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setIsFilePickerOpen(true)}
              title="Attach confidential project file"
              style={{ padding: '8px 12px', fontSize: '13px' }}
            >
              📎 Attach
            </button>
            <input
              type="text"
              placeholder="Ask the selected model, explore requirements, or formulate analysis..."
              value={inputContent}
              onChange={(e) => setInputContent(e.target.value)}
              disabled={sending || !activeConvId}
              style={{
                flex: 1,
                padding: '9px 14px',
                borderRadius: '6px',
                border: '1px solid var(--border-color, #444444)',
                backgroundColor: 'var(--bg-primary, #121212)',
                color: 'inherit',
                fontSize: '13px',
              }}
            />
            <button
              type="submit"
              className="btn-primary"
              disabled={sending || (!inputContent.trim() && attachments.length === 0) || !activeConvId}
              style={{ padding: '9px 18px', fontSize: '13px' }}
            >
              {sending ? 'Processing...' : 'Send'}
            </button>
          </form>
        </div>
      </div>

      {/* File Picker Modal */}
      <FilePickerModal
        isOpen={isFilePickerOpen}
        onClose={() => setIsFilePickerOpen(false)}
        onSelect={(newAtts) => setAttachments((prev) => [...prev, ...newAtts])}
      />

      {/* Promote to Task Modal */}
      {promoteModalData.isOpen && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="modal-card"
            style={{
              backgroundColor: 'var(--bg-secondary, #1e1e1e)',
              color: 'var(--text-primary, #ffffff)',
              borderRadius: '8px',
              width: '100%',
              maxWidth: '540px',
              padding: '20px',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
              border: '1px solid var(--border-color, #333333)',
            }}
          >
            <h2 style={{ margin: '0 0 12px 0', fontSize: '18px', fontWeight: 600 }}>
              ⚡ Promote Exploration to Tracked Task
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--text-dim, #888888)', margin: '0 0 16px 0' }}>
              Convert this chat context into an officially orchestrated industrial task. The task will be enqueued in server storage and run through the typed agent DAG.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                  Task Description
                </label>
                <textarea
                  value={promoteModalData.description}
                  onChange={(e) => setPromoteModalData({ ...promoteModalData, description: e.target.value })}
                  rows={3}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color, #444444)',
                    backgroundColor: 'var(--bg-primary, #121212)',
                    color: 'inherit',
                    fontSize: '13px',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                    Target Agent
                  </label>
                  <select
                    value={promoteModalData.agent}
                    onChange={(e) => setPromoteModalData({ ...promoteModalData, agent: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color, #444444)',
                      backgroundColor: 'var(--bg-primary, #121212)',
                      color: 'inherit',
                      fontSize: '13px',
                    }}
                  >
                    <option value="supervisor_agent">supervisor_agent (Orchestrator)</option>
                    <option value="ingest_agent">ingest_agent (OCR / Extraction)</option>
                    <option value="analyst_agent">analyst_agent (Analysis & Rules)</option>
                    <option value="code_agent">code_agent (Offline Sandbox)</option>
                    <option value="coder_agent">coder_agent (Offline Sandbox Coder)</option>
                    <option value="report_agent">report_agent (Office Deliverables)</option>
                  </select>
                </div>

                <div style={{ width: '130px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                    Complexity
                  </label>
                  <select
                    value={promoteModalData.complexity}
                    onChange={(e) => setPromoteModalData({ ...promoteModalData, complexity: e.target.value as any })}
                    style={{
                      width: '100%',
                      padding: '8px',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color, #444444)',
                      backgroundColor: 'var(--bg-primary, #121212)',
                      color: 'inherit',
                      fontSize: '13px',
                    }}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
              </div>

              {activeConv?.mode === 'brainstorm' && (
                <div style={{ padding: '10px', backgroundColor: 'rgba(234, 179, 8, 0.1)', border: '1px solid var(--accent-warning, #eab308)', borderRadius: '4px' }}>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', cursor: 'pointer', color: 'var(--accent-warning, #eab308)' }}>
                    <input
                      type="checkbox"
                      checked={promoteModalData.allowUnreviewedBrainstorm}
                      onChange={(e) => setPromoteModalData((prev) => ({ ...prev, allowUnreviewedBrainstorm: e.target.checked }))}
                      style={{ marginTop: '2px' }}
                    />
                    <span><strong>Acknowledge unreviewed brainstorm content:</strong> I confirm unverified brainstorm exploratory claims may be promoted to this industrial task.</span>
                  </label>
                </div>
              )}
            </div>

            <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                className="btn-secondary"
                onClick={() => setPromoteModalData((prev) => ({ ...prev, isOpen: false }))}
                style={{ padding: '6px 14px' }}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handlePromoteConfirm}
                style={{ padding: '6px 18px', backgroundColor: 'var(--accent, #3b82f6)' }}
              >
                Promote & Enqueue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Downgrade Confirmation Modal */}
      {isDowngradeModalOpen && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="modal-card"
            style={{
              backgroundColor: 'var(--bg-secondary, #1e1e1e)',
              color: 'var(--text-primary, #ffffff)',
              borderRadius: '8px',
              width: '100%',
              maxWidth: '480px',
              padding: '20px',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
              border: '1px solid var(--accent-warning, #eab308)',
            }}
          >
            <h2 style={{ margin: '0 0 12px 0', fontSize: '18px', fontWeight: 600, color: 'var(--accent-warning, #eab308)' }}>
              ⚠️ Confirm Mode Downgrade
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--text-primary, #ffffff)', margin: '0 0 12px 0', lineHeight: 1.5 }}>
              You are switching from <strong>Evidence (Industrial) Mode</strong> to <strong>Brainstorm Mode</strong>.
            </p>
            <p style={{ fontSize: '12px', color: 'var(--text-dim, #888888)', margin: '0 0 16px 0', lineHeight: 1.4 }}>
              In Brainstorm Mode, citations are no longer strictly enforced, and model-generated prose is exploratory. Brainstorm content cannot be promoted to industrial tasks or deliverables without explicit review confirmation. Silent downgrades are strictly forbidden.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                className="btn-secondary"
                onClick={() => {
                  setIsDowngradeModalOpen(false);
                  setPendingMode(null);
                }}
                style={{ padding: '6px 14px' }}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleConfirmDowngrade}
                style={{ padding: '6px 18px', backgroundColor: 'var(--accent-warning, #eab308)', color: '#000000', fontWeight: 600 }}
              >
                Confirm Downgrade
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
