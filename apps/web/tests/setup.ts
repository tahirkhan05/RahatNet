/**
 * Vitest global test setup.
 *
 * Runs before every test file.  Responsibilities:
 *   1. Start the MSW server before all tests, reset handlers after each test,
 *      and close the server after all tests complete.
 *   2. Extend the Vitest `expect` with @testing-library/jest-dom matchers
 *      (toBeInTheDocument, toHaveRole, etc.).
 *   3. Extend `expect` with jest-axe matchers (toHaveNoViolations).
 *   4. Suppress noisy console.error output from React error boundaries and
 *      missing act() warnings in tests — these are expected and clutter output.
 *   5. Mock global browser APIs that jsdom doesn't implement:
 *        - window.matchMedia (used by the theme system)
 *        - navigator.geolocation (used by useGeolocation / location hooks)
 *        - window.crypto.randomUUID (used by report ID generation)
 *        - ResizeObserver (used by recharts)
 *        - IntersectionObserver (used by react-window)
 */

import '@testing-library/jest-dom';
import { beforeAll, afterAll, afterEach, vi } from 'vitest';
import { expect } from 'vitest';
import { toHaveNoViolations } from 'jest-axe';
import { server } from './mocks/server';

// ---------------------------------------------------------------------------
// 1. Extend expect with jest-axe matchers
// ---------------------------------------------------------------------------

expect.extend(toHaveNoViolations);

// ---------------------------------------------------------------------------
// 2. MSW server lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  server.listen({
    // Error on unhandled requests so missing handlers surface as test failures,
    // not silent network errors.
    onUnhandledRequest: 'error',
  });
});

afterEach(() => {
  // Reset per-test overrides added with server.use() so they don't bleed.
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// 3. Suppress expected console noise
// ---------------------------------------------------------------------------

const originalConsoleError = console.error.bind(console);

beforeAll(() => {
  console.error = (...args: unknown[]) => {
    const msg = String(args[0] ?? '');
    // Suppress React's act() warning — we use userEvent which wraps in act.
    if (msg.includes('not wrapped in act')) return;
    // Suppress jsdom "not implemented" for navigation.
    if (msg.includes('Not implemented')) return;
    // Suppress React error boundary errors — tested intentionally in boundary tests.
    if (msg.includes('The above error occurred in the')) return;
    if (msg.includes('React will try to recreate this component tree')) return;
    originalConsoleError(...args);
  };
});

afterAll(() => {
  console.error = originalConsoleError;
});

// ---------------------------------------------------------------------------
// 4. Global browser API stubs
// ---------------------------------------------------------------------------

// window.matchMedia — not implemented in jsdom.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches:             false,
    media:               query,
    onchange:            null,
    addListener:         vi.fn(),
    removeListener:      vi.fn(),
    addEventListener:    vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent:       vi.fn(),
  })),
});

// navigator.geolocation — return a Kerala coordinate by default.
Object.defineProperty(navigator, 'geolocation', {
  writable: true,
  value: {
    getCurrentPosition: vi.fn().mockImplementation(
      (success: PositionCallback) =>
        success({
          coords: {
            latitude:  10.0167,
            longitude: 76.3417,
            accuracy:  10,
            altitude:         null,
            altitudeAccuracy: null,
            heading:          null,
            speed:            null,
          },
          timestamp: Date.now(),
        } as GeolocationPosition),
    ),
    watchPosition:  vi.fn().mockReturnValue(1),
    clearWatch:     vi.fn(),
  },
});

// window.crypto.randomUUID — jsdom supports this in newer versions,
// but polyfill in case tests run on an older jsdom.
if (typeof crypto.randomUUID !== 'function') {
  Object.defineProperty(crypto, 'randomUUID', {
    value: () => {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    },
  });
}

// ResizeObserver — used by recharts and other layout-aware components.
global.ResizeObserver = class ResizeObserver {
  observe()   {}
  unobserve() {}
  disconnect() {}
};

// IntersectionObserver — used by react-window virtualized lists.
global.IntersectionObserver = class IntersectionObserver {
  readonly root          = null;
  readonly rootMargin    = '';
  readonly thresholds    = [];
  observe()    {}
  unobserve()  {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
} as unknown as typeof IntersectionObserver;

// navigator.vibrate — used by TaskAcceptModal haptic feedback.
Object.defineProperty(navigator, 'vibrate', {
  writable: true,
  value: vi.fn().mockReturnValue(true),
});

// navigator.serviceWorker — minimal stub for hooks that check for SW support.
if (!('serviceWorker' in navigator)) {
  Object.defineProperty(navigator, 'serviceWorker', {
    writable: true,
    value: {
      ready:               Promise.resolve({ sync: { register: vi.fn() } }),
      addEventListener:    vi.fn(),
      removeEventListener: vi.fn(),
      controller:          null,
    },
  });
}

// IndexedDB — jsdom includes a partial IDB implementation; ensure it is
// available (this is a no-op in Node 20 / jsdom 24).
if (!('indexedDB' in globalThis)) {
  Object.defineProperty(globalThis, 'indexedDB', { writable: true, value: undefined });
}
