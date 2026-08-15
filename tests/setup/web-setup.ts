/**
 * jsdom setup for component tests.
 *
 * Provides the browser APIs jsdom lacks that our components legitimately use.
 * Each stub is here because a real component depends on it — none is
 * speculative.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

/**
 * `matchMedia` is not implemented in jsdom, and `useReducedMotion` subscribes
 * to it. Defaults to "no preference" so tests exercise the full-motion path;
 * individual tests override it to assert the reduced path.
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
