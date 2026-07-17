import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Thin `execFile` wrapper. Always invoked with an argument array (never a
 * shell string), so paths carrying spaces or shell metacharacters pass
 * through unmangled and there is no shell-injection surface. Isolated in
 * its own module so tests can mock the single external-process seam.
 */
export async function run(command: string, args: string[]): Promise<RunResult> {
  // Default execFile encoding yields string stdout/stderr.
  const { stdout, stderr } = await execFileAsync(command, args);
  return { stdout, stderr };
}

/** True when the error is a "command not found" from execFile. */
export function isMissingBinaryError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
