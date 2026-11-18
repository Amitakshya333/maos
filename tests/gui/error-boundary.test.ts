// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary } from '../../src/gui/src/components/ErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ProblemChild: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) {
    throw new Error('Test exploded in child component');
  }
  return React.createElement('div', { 'data-testid': 'happy-child' }, 'All systems normal');
};

describe('ErrorBoundary Component', () => {
  it('renders children normally when there is no error', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(ErrorBoundary, null, React.createElement(ProblemChild, { shouldThrow: false })));
    });

    const child = container.querySelector('[data-testid="happy-child"]');
    expect(child).not.toBeNull();
    expect(child?.textContent).toBe('All systems normal');
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('catches render error and displays the fallback card with retry button', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      root.render(
        React.createElement(
          ErrorBoundary,
          { fallbackTitle: 'Agent API offline — retrying in 5s' },
          React.createElement(ProblemChild, { shouldThrow: true }),
        ),
      );
    });

    const card = container.querySelector('[data-testid="error-boundary-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Agent API offline — retrying in 5s');
    expect(card?.textContent).toContain('Test exploded in child component');

    const retryBtn = container.querySelector('[data-testid="error-boundary-retry-button"]');
    expect(retryBtn).not.toBeNull();

    consoleErrorSpy.mockRestore();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
