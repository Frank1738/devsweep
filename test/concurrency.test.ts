import { describe, expect, it } from 'vitest';
import { limiter } from '../src/concurrency.js';

describe('limiter', () => {
  it('never runs more than its limit at once, across every caller', async () => {
    const slot = limiter(2);
    let running = 0;
    let most = 0;
    const task = () =>
      slot(async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return running;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(most).toBe(2);
  });

  it('frees its slot when a task fails', async () => {
    const slot = limiter(1);
    await expect(slot(() => Promise.reject(new Error('no')))).rejects.toThrow('no');
    await expect(slot(async () => 'yes')).resolves.toBe('yes');
  });
});
