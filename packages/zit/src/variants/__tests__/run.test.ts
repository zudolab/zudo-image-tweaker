/**
 * Exec hardening for the shared variants runner (issue #88 / sources #66,
 * #67): every path handed to an external binary is resolved before it
 * reaches argv, and every invocation carries a bounded timeout so a hung
 * binary can't stall a batch forever.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBinaryPath, run } from '../run.js';

describe('resolveBinaryPath (issue #66)', () => {
  it('resolves a leading-dash relative filename to an absolute path', () => {
    const resolved = resolveBinaryPath('-rf.jpg');
    expect(resolved).toBe(path.resolve('-rf.jpg'));
    expect(resolved.startsWith('/')).toBe(true);
    expect(resolved.startsWith('-')).toBe(false);
  });

  it('leaves an already-absolute path unchanged', () => {
    expect(resolveBinaryPath('/a/b/c.jpg')).toBe('/a/b/c.jpg');
  });
});

describe('run subprocess timeout (issue #67)', () => {
  it('kills a hung subprocess after the given timeoutMs instead of hanging forever', async () => {
    // `sleep 5` stands in for a hung binary; a 100ms timeoutMs must reject
    // well before it would exit on its own.
    await expect(run('sleep', ['5'], { timeoutMs: 100 })).rejects.toThrow();
  }, 10_000);

  it('still resolves normally for a fast command with a short timeout', async () => {
    const result = await run('echo', ['ok'], { timeoutMs: 5_000 });
    expect(result.stdout.trim()).toBe('ok');
  });

  it('applies the 60s default timeout when none is supplied (fast command still succeeds)', async () => {
    const result = await run('echo', ['ok']);
    expect(result.stdout.trim()).toBe('ok');
  });
});
