import React, { Component, ErrorInfo, ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  autoRetryMs?: number;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  countdown: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private timer: number | null = null;

  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    countdown: 5,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error, countdown: 5 };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an unhandled error:', error, errorInfo);
    const retryInterval = this.props.autoRetryMs ?? 5000;
    this.startCountdown(Math.max(1, Math.ceil(retryInterval / 1000)));
  }

  private startCountdown(seconds: number) {
    this.setState({ countdown: seconds });
    if (this.timer) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      this.setState((prev) => {
        if (prev.countdown <= 1) {
          if (this.timer) window.clearInterval(this.timer);
          this.timer = null;
          return { hasError: false, error: null, countdown: 5 };
        }
        return { ...prev, countdown: prev.countdown - 1 };
      });
    }, 1000);
  }

  public componentWillUnmount() {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private handleRetry = () => {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.setState({ hasError: false, error: null, countdown: 5 });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          data-testid="error-boundary-card"
          style={{
            padding: '24px',
            margin: '20px',
            backgroundColor: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '8px',
            color: '#c9d1d9',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
            <span style={{ fontSize: '20px' }}>⚠️</span>
            <h3 style={{ margin: 0, fontSize: '16px', color: '#f85149' }}>
              {this.props.fallbackTitle || 'Agent API offline — retrying in 5s'}
            </h3>
          </div>
          <p style={{ margin: '0 0 16px 0', fontSize: '13px', color: '#8b949e', lineHeight: 1.5 }}>
            {this.state.error?.message || 'An unexpected error occurred while communicating with the service.'}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              onClick={this.handleRetry}
              data-testid="error-boundary-retry-button"
              style={{
                backgroundColor: '#238636',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '6px 16px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Retry Now
            </button>
            <span style={{ fontSize: '12px', color: '#8b949e' }}>Auto-retrying in {this.state.countdown}s...</span>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
