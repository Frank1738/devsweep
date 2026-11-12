import { stripVTControlCharacters as plain } from 'node:util';
import { describe, expect, it } from 'vitest';
import { startSweep } from '../src/ui/sweep.js';

function capture() {
  const writes: string[] = [];
  return { writes, write: (text: string) => writes.push(text) };
}

describe('startSweep', () => {
  it('sweeps the track clean, then clears the line and restores the cursor', async () => {
    const out = capture();
    const stop = startSweep({ ...out, label: '../frontend', color: false, passMs: 40, frameMs: 5 });
    await stop();

    expect(out.writes[0]).toBe('\u001b[?25l');
    expect(out.writes.slice(-2)).toEqual(['\r\u001b[2K', '\u001b[?25h']);
    const frames = out.writes.filter((w) => w.includes('devsweep')).map(plain);
    expect(frames[0]).toBe(`\r  devsweep  ${'·'.repeat(24)}  ../frontend`);
    expect(frames.at(-1)).toBe(`\r  devsweep  ${'━'.repeat(24)}  ../frontend`);
  });

  it('removes its interrupt and exit handlers when stopped', async () => {
    const sigint = process.listenerCount('SIGINT');
    const exit = process.listenerCount('exit');
    const stop = startSweep({ ...capture(), label: 'x', color: false, passMs: 20, frameMs: 5 });
    expect(process.listenerCount('SIGINT')).toBe(sigint + 1);
    await stop();
    expect([process.listenerCount('SIGINT'), process.listenerCount('exit')]).toEqual([
      sigint,
      exit,
    ]);
  });

  it('shortens the label so the animation stays on one line', async () => {
    const out = capture();
    const label = `../${'deep/'.repeat(20)}repo`;
    const stop = startSweep({ ...out, label, color: false, width: 60, passMs: 20, frameMs: 5 });
    await stop();
    const frame = plain(out.writes.find((w) => w.includes('devsweep')) ?? '');
    expect(frame.replace('\r', '').length).toBeLessThan(60);
    expect(frame.endsWith('/repo')).toBe(true);
  });
});
