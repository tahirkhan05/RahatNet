/**
 * Tests for hooks/useOffline.ts
 *
 * The hook combines three network signals:
 *   1. navigator.onLine (instant)
 *   2. Heartbeat fetch to /api/health (every 30 s)
 *   3. navigator.connection.effectiveType (slow-2g / 2g → slow)
 *
 * Testing strategy:
 *   - Fake timers control setInterval / setTimeout so tests run instantly.
 *   - navigator.onLine is overridden via Object.defineProperty.
 *   - fetch is mocked via MSW; specific tests override the handler.
 *   - TRIGGER_SYNC messages are verified via navigator.serviceWorker mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/tests/mocks/server';

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

// Stub navigator.serviceWorker.
const mockPostMessage = vi.fn();
const mockController  = { postMessage: mockPostMessage };

Object.defineProperty(navigator, 'serviceWorker', {
  writable: true,
  value: {
    addEventListener:    vi.fn(),
    removeEventListener: vi.fn(),
    controller:          mockController,
  },
});

// Make navigator.onLine writable.
let mockOnLine = true;
Object.defineProperty(navigator, 'onLine', {
  get:        () => mockOnLine,
  configurable: true,
});

// ---------------------------------------------------------------------------
// IndexedDB mock (needed by the hook's pendingCount poll)
// ---------------------------------------------------------------------------

vi.mock('@/lib/utils/indexeddb', () => ({
  getPendingReports: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Import hook (after mocks)
// ---------------------------------------------------------------------------

import { useOffline } from '@/hooks/useOffline';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useOffline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mockOnLine = true;
    mockPostMessage.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports isOnline=true initially when navigator.onLine is true', async () => {
    const { result } = renderHook(() => useOffline());

    // Allow the initial heartbeat to resolve.
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // MSW default handler returns 200 from /api/health.
    expect(result.current.isOnline).toBe(true);
  });

  it('isOnline → false when the heartbeat returns a network error', async () => {
    server.use(
      http.get('/api/health', () => {
        throw new Error('Network error');
      }),
    );

    const { result } = renderHook(() => useOffline());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.isOnline).toBe(false);
  });

  it('transitions to offline when the browser offline event fires', async () => {
    const { result } = renderHook(() => useOffline());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.isOnline).toBe(true);

    await act(async () => {
      mockOnLine = false;
      window.dispatchEvent(new Event('offline'));
    });

    expect(result.current.isOnline).toBe(false);
  });

  it('transitions back to online and triggers TRIGGER_SYNC when online event fires', async () => {
    mockOnLine = false;
    const { result } = renderHook(() => useOffline());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      mockOnLine = true;
      window.dispatchEvent(new Event('online'));
      await vi.runAllTimersAsync();
    });

    // The hook should have posted TRIGGER_SYNC to the SW controller.
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'TRIGGER_SYNC' });
  });

  it('runs the heartbeat again after 30 seconds', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');

    renderHook(() => useOffline());

    // Initial heartbeat.
    await act(async () => { await vi.runAllTimersAsync(); });
    const initialCallCount = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).includes('/api/health'),
    ).length;

    // Advance 30 seconds → another heartbeat.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await vi.runAllTimersAsync();
    });

    const newCallCount = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).includes('/api/health'),
    ).length;

    expect(newCallCount).toBeGreaterThan(initialCallCount);
    fetchSpy.mockRestore();
  });

  it('pendingCount reflects IndexedDB pending reports', async () => {
    const { getPendingReports } = await import('@/lib/utils/indexeddb');
    vi.mocked(getPendingReports).mockResolvedValue([
      { id: 'r1' } as never,
      { id: 'r2' } as never,
      { id: 'r3' } as never,
    ]);

    const { result } = renderHook(() => useOffline(30_000, 100));

    await act(async () => {
      vi.advanceTimersByTime(200); // trigger IDB poll
      await vi.runAllTimersAsync();
    });

    expect(result.current.pendingCount).toBe(3);
  });

  it('decrements pendingCount by 1 on REPORT_SYNCED SW message', async () => {
    const { getPendingReports } = await import('@/lib/utils/indexeddb');
    vi.mocked(getPendingReports).mockResolvedValue([{ id: 'r1' } as never]);

    // Override serviceWorker addEventListener to capture the message listener.
    let swMessageHandler: ((e: MessageEvent) => void) | undefined;
    vi.spyOn(navigator.serviceWorker, 'addEventListener').mockImplementation(
      (type, handler) => {
        if (type === 'message') swMessageHandler = handler as (e: MessageEvent) => void;
      },
    );

    const { result } = renderHook(() => useOffline(30_000, 100));

    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    expect(result.current.pendingCount).toBe(1);

    // Simulate the SW posting REPORT_SYNCED.
    await act(async () => {
      swMessageHandler?.(new MessageEvent('message', {
        data: { type: 'REPORT_SYNCED', reportId: 'r1' },
      }));
    });

    expect(result.current.pendingCount).toBe(0);
  });

  it('pendingCount never goes below 0', async () => {
    const { getPendingReports } = await import('@/lib/utils/indexeddb');
    vi.mocked(getPendingReports).mockResolvedValue([]);

    let swMessageHandler: ((e: MessageEvent) => void) | undefined;
    vi.spyOn(navigator.serviceWorker, 'addEventListener').mockImplementation(
      (type, handler) => {
        if (type === 'message') swMessageHandler = handler as (e: MessageEvent) => void;
      },
    );

    const { result } = renderHook(() => useOffline(30_000, 100));

    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    expect(result.current.pendingCount).toBe(0);

    await act(async () => {
      swMessageHandler?.(new MessageEvent('message', {
        data: { type: 'REPORT_SYNCED', reportId: 'r1' },
      }));
    });

    expect(result.current.pendingCount).toBe(0); // still 0, not -1
  });

  it('isSlowConnection=true when navigator.connection.effectiveType is "2g"', async () => {
    const mockConnection = { effectiveType: '2g', addEventListener: vi.fn(), removeEventListener: vi.fn() };
    Object.defineProperty(navigator, 'connection', { value: mockConnection, configurable: true });

    const { result } = renderHook(() => useOffline());

    expect(result.current.isSlowConnection).toBe(true);

    // Cleanup
    Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true });
  });
});
