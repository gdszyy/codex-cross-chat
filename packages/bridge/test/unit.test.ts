/**
 * Pure-logic unit tests (§7.2 reconnect backoff, mock fault parsing contract).
 */
import { describe, expect, it } from 'vitest';
import { backoffDelay } from '../src/relayClient.js';

describe('§7.2 reconnect backoff', () => {
  it('grows exponentially and is capped at 60s', () => {
    expect(backoffDelay(0, 60_000)).toBe(500);
    expect(backoffDelay(1, 60_000)).toBe(1000);
    expect(backoffDelay(2, 60_000)).toBe(2000);
    expect(backoffDelay(7, 60_000)).toBe(60_000);
    // never exceeds the ceiling, however many attempts have failed
    expect(backoffDelay(50, 60_000)).toBe(60_000);
  });

  it('honours a custom ceiling', () => {
    expect(backoffDelay(3, 5_000)).toBe(4_000);
    expect(backoffDelay(4, 5_000)).toBe(5_000);
  });
});
