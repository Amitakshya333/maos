import React, { useState, useEffect, useRef } from 'react';
import { apiAdapter } from '../api';
import type { ProjectFileInfo, ChatAttachment } from '../../../domain/conversation';
import { ATTACHMENT_BOUNDS } from '../../../domain/conversation';

interface FilePickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (attachments: ChatAttachment[]) => void;
  maxSelectable?: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export const FilePickerModal: React.FC<FilePickerModalProps> = ({
  isOpen,
  onClose,
  onSelect,
  maxSelectable = 5,
}) => {
  const [files, setFiles] = useState<ProjectFileInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [searchFilter, setSearchFilter] = useState<string>('');
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setSelectedPaths(new Set());
      setSearchFilter('');
      return;
    }
    if (modalRef.current) {
      modalRef.current.focus();
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    loadFiles();
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const loadFiles = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiAdapter.getProjectFiles();
      setFiles(res);
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to list project files');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const toggleSelect = (file: ProjectFileInfo) => {
    if (file.isDirectory) return;
    if (file.size > ATTACHMENT_BOUNDS.MAX_ATTACHMENT_SIZE_BYTES) return;

    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(file.path)) {
        next.delete(file.path);
      } else {
        if (next.size >= maxSelectable) return prev;
        next.add(file.path);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const selectedFiles = files.filter((f) => selectedPaths.has(f.path));
    const attachments: ChatAttachment[] = selectedFiles.map((f) => ({
      id: `att_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: f.name,
      relativePath: f.path,
      sizeBytes: f.size,
      mimeType: getMimeType(f.name),
    }));
    onSelect(attachments);
    onClose();
  };

  const filteredFiles = files.filter((f) => {
    if (!searchFilter.trim()) return true;
    return f.name.toLowerCase().includes(searchFilter.toLowerCase()) || f.path.toLowerCase().includes(searchFilter.toLowerCase());
  });

  return (
    <div
      className="modal-backdrop"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '16px',
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-picker-title"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="modal-card"
        style={{
          backgroundColor: 'var(--bg-secondary, #1e1e1e)',
          color: 'var(--text-primary, #ffffff)',
          borderRadius: '8px',
          width: '100%',
          maxWidth: '680px',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          border: '1px solid var(--border-color, #333333)',
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-color, #333333)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <h2 id="file-picker-title" style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
              Attach Local Project Evidence
            </h2>
            <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-dim, #888888)' }}>
              🔒 Confined strictly to project root • Max 50 MB per file • Max {maxSelectable} files
            </p>
          </div>
          <button
            onClick={onClose}
            className="btn-icon"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-dim, #888888)',
              fontSize: '20px',
              cursor: 'pointer',
            }}
            aria-label="Close file picker"
          >
            ✕
          </button>
        </div>

        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color, #333333)' }}>
          <input
            type="text"
            className="input-search"
            placeholder="Filter files in project root..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: '4px',
              border: '1px solid var(--border-color, #444444)',
              backgroundColor: 'var(--bg-primary, #121212)',
              color: 'inherit',
              fontSize: '13px',
            }}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px', minHeight: '200px' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-dim, #888888)' }}>
              Scanning local project files...
            </div>
          ) : error ? (
            <div style={{ textAlign: 'center', padding: '30px', color: 'var(--status-red, #ff5555)' }}>
              {error}
            </div>
          ) : filteredFiles.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-dim, #888888)' }}>
              No files found matching criteria.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {filteredFiles.map((file) => {
                const isSelected = selectedPaths.has(file.path);
                const isOversized = file.size > ATTACHMENT_BOUNDS.MAX_ATTACHMENT_SIZE_BYTES;
                const isDir = file.isDirectory;

                return (
                  <div
                    key={file.path}
                    onClick={() => !isOversized && !isDir && toggleSelect(file)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '8px 12px',
                      borderRadius: '4px',
                      backgroundColor: isSelected
                        ? 'var(--accent-dim, rgba(59, 130, 246, 0.15))'
                        : 'var(--bg-tertiary, #252525)',
                      border: isSelected
                        ? '1px solid var(--accent, #3b82f6)'
                        : '1px solid transparent',
                      cursor: isOversized || isDir ? 'not-allowed' : 'pointer',
                      opacity: isOversized ? 0.6 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={isOversized || isDir}
                      onChange={() => toggleSelect(file)}
                      style={{ marginRight: '12px' }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500, fontSize: '13px' }}>
                        {isDir ? '📁 ' : '📄 '}
                        {file.name}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-dim, #888888)' }}>
                        {file.path}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span
                        style={{
                          fontSize: '12px',
                          color: isOversized ? 'var(--status-red, #ff5555)' : 'var(--text-dim, #aaaaaa)',
                        }}
                      >
                        {isDir ? 'Directory' : formatBytes(file.size)}
                      </span>
                      {isOversized && (
                        <div style={{ fontSize: '10px', color: 'var(--status-red, #ff5555)', fontWeight: 600 }}>
                          OVERSIZED (&gt;50MB)
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '14px 20px',
            borderTop: '1px solid var(--border-color, #333333)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--text-dim, #888888)' }}>
            Selected: {selectedPaths.size} / {maxSelectable}
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn-secondary" onClick={onClose} style={{ padding: '6px 14px' }}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={selectedPaths.size === 0}
              onClick={handleConfirm}
              style={{ padding: '6px 16px' }}
            >
              Attach ({selectedPaths.size})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'csv':
      return 'text/csv';
    case 'json':
      return 'application/json';
    case 'txt':
      return 'text/plain';
    case 'md':
      return 'text/markdown';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}
