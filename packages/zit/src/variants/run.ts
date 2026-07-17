import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Default subprocess timeout (issue #67): long enough for a real
 * conversion/feature-probe, short enough that a single hung binary can't
 * stall a whole variants batch forever.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Kill the subprocess if it hasn't exited after this many ms. @default 60000 */
  timeoutMs?: number;
  /**
   * Signal used to kill a timed-out subprocess. @default 'SIGKILL' — a
   * binary that installs a SIGTERM handler (or otherwise ignores it) would
   * defeat the timeout under SIGTERM; SIGKILL cannot be caught or ignored,
   * so the timeout stays a hard bound regardless of the target's own
   * signal handling.
   */
  killSignal?: NodeJS.Signals;
}

/**
 * Thin `execFile` wrapper. Always invoked with an argument array (never a
 * shell string), so paths carrying spaces or shell metacharacters pass
 * through unmangled and there is no shell-injection surface. Isolated in
 * its own module so tests can mock the single external-process seam.
 *
 * Every invocation carries a timeout (default 60s, see {@link RunOptions});
 * a timed-out subprocess is killed and `execFile` rejects, which every
 * caller already treats the same as any other non-ENOENT failure (see
 * each module's existing null/fallback contract).
 */
export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, killSignal = 'SIGKILL' } = options;
  // Default execFile encoding yields string stdout/stderr.
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    killSignal,
  });
  return { stdout, stderr };
}

/**
 * Resolve a caller-supplied path before it lands in an external binary's
 * argv (issue #66), so a bare leading-dash relative filename (e.g.
 * `-rf.jpg`) can never be parsed as an option flag by the invoked binary.
 */
export function resolveBinaryPath(inputPath: string): string {
  return path.resolve(inputPath);
}

/** True when the error is a "command not found" from execFile. */
export function isMissingBinaryError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
