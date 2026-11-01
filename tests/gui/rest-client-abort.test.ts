/**
 * REST client abort handling (COMPLETION-FIX-10 finding 1, FIX-12 finding 2).
 * A pre-aborted caller signal must not start a request; listener cleanup is
 * mandatory. Caller cancellation stays an abort outcome while the client's
 * own deadline remains a TimeoutError. Loopback/injected fetch only.
 */
import { describe, expect, it, vi } from 'vitest';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';

function okFetch(body: unknown = { data: {} }) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  }));
}

function hangingFetch(onAbort?: (reason?: unknown) => void) {
  return vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
    await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          if (onAbort) onAbort(init.signal?.reason);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        },
        { once: true },
      );
    });
    throw new Error('unreachable');
  });
}

function clientWith(fetchFn: ReturnType<typeof vi.fn>) {
  return new BrowserRestClient({
    baseUrl: 'http://127.0.0.1:9',
    projectRoot: 'C:\\maos-test',
    fetchFn: fetchFn as unknown as typeof fetch,
    defaultTimeoutMs: 5_000,
  });
}

describe('BrowserRestClient abort handling', () => {
  it('does not start a request when the caller signal is already aborted', async () => {
    const fetchFn = okFetch();
    const client = clientWith(fetchFn);
    const controller = new AbortController();
    controller.abort(new DOMException('Caller cancelled.', 'AbortError'));
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(
      client.request('GET', '/api/v1/chat/health', undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('detaches the forwarding listener once a normal request settles', async () => {
    const fetchFn = okFetch();
    const client = clientWith(fetchFn);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');

    await client.request('GET', '/api/v1/chat/health', undefined, { signal: controller.signal, timeoutMs: 5_000 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
  });

  it('reports mid-flight caller cancellation as an abort, not a timeout', async () => {
    const seen: unknown[] = [];
    const fetchFn = hangingFetch((reason) => {
      seen.push(reason);
    });
    const client = clientWith(fetchFn);
    const controller = new AbortController();
    const pending = client.request('GET', '/api/v1/chat/health', undefined, {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    controller.abort(new DOMException('Caller cancelled mid-flight.', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.not.toMatchObject({ name: 'TimeoutError' });
    expect(seen).toHaveLength(1);
  });

  it('normalizes a custom string abort reason to AbortError, never TimeoutError', async () => {
    const fetchFn = hangingFetch();
    const client = clientWith(fetchFn);
    const controller = new AbortController();
    const pending = client.request('GET', '/api/v1/chat/health', undefined, {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    controller.abort('user pressed cancel');
    const err = (await pending.catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
    expect(err.name).not.toBe('TimeoutError');
    // Non-Error reasons are normalized, not surfaced verbatim.
    expect(err.message).not.toContain('user pressed cancel');
  });

  it('does not start a request for a pre-aborted string reason', async () => {
    const fetchFn = okFetch();
    const client = clientWith(fetchFn);
    const controller = new AbortController();
    controller.abort('already cancelled');
    const err = (await client
      .request('GET', '/api/v1/chat/health', undefined, { signal: controller.signal })
      .catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('AbortError');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not start a download for a pre-aborted string reason', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      blob: async () => new Blob(['x']),
    }));
    const client = clientWith(fetchFn);
    const controller = new AbortController();
    controller.abort('already cancelled');
    const err = (await client
      .downloadArtifactContent('run-1', { signal: controller.signal })
      .catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('AbortError');
    expect(err.message).not.toContain('already cancelled');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('still reports the client deadline as a timeout when the caller did not abort', async () => {
    const fetchFn = hangingFetch();
    const client = new BrowserRestClient({
      baseUrl: 'http://127.0.0.1:9',
      projectRoot: 'C:\\maos-test',
      fetchFn: fetchFn as unknown as typeof fetch,
      defaultTimeoutMs: 40,
    });
    await expect(client.request('GET', '/api/v1/chat/health')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('downloadArtifactContent abort handling', () => {
  function blobFetch() {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      blob: async () => new Blob(['synthetic-bytes']),
    }));
  }

  it('does not start a download when the caller signal is already aborted', async () => {
    const fetchFn = blobFetch();
    const client = clientWith(fetchFn);
    const controller = new AbortController();
    controller.abort('caller stopped the download');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(client.downloadArtifactContent('run-1', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('reports caller cancellation with a string reason as an abort, and cleans up', async () => {
    const fetchFn = hangingFetch();
    const client = clientWith(fetchFn);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = client.downloadArtifactContent('run-1', { signal: controller.signal, timeoutMs: 5_000 });
    controller.abort('caller stopped the download');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.not.toMatchObject({ name: 'TimeoutError' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('reports caller cancellation with an undefined reason as an abort', async () => {
    const fetchFn = hangingFetch();
    const client = clientWith(fetchFn);
    const controller = new AbortController();
    const pending = client.downloadArtifactContent('run-1', { signal: controller.signal, timeoutMs: 5_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.not.toMatchObject({ name: 'TimeoutError' });
  });

  it('still reports the client deadline as a timeout for downloads', async () => {
    const fetchFn = hangingFetch();
    const client = new BrowserRestClient({
      baseUrl: 'http://127.0.0.1:9',
      projectRoot: 'C:\\maos-test',
      fetchFn: fetchFn as unknown as typeof fetch,
      defaultTimeoutMs: 40,
    });
    await expect(client.downloadArtifactContent('run-1')).rejects.toMatchObject({
      name: 'TimeoutError',
      message: expect.stringContaining('run-1'),
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns the blob and detaches the listener on success', async () => {
    const fetchFn = blobFetch();
    const client = clientWith(fetchFn);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const blob = await client.downloadArtifactContent('run-1', { signal: controller.signal });
    expect(await blob.text()).toBe('synthetic-bytes');
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
