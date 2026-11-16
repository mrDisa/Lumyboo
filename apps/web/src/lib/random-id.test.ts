import { afterEach, expect, it, vi } from 'vitest';
import { randomId } from './random-id';
afterEach(() => vi.unstubAllGlobals());
it('uses random bytes when HTTP does not expose randomUUID', () => {
 const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes.fill(255); return bytes; });
 vi.stubGlobal('crypto', { getRandomValues });
 expect(randomId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
 expect(getRandomValues).toHaveBeenCalledOnce();
});
