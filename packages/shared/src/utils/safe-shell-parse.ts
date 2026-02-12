import { parse as shellParse } from 'shell-quote';

/**
 * Merge-safety shim: keep parser hardening additive so hot resolver logic stays small.
 * Some command strings (e.g. `${k.toUpperCase()}`) can throw parse errors.
 */
export function parseShellTokensSafe(command: string): string[] | undefined {
  try {
    const parsed = shellParse(command);
    return parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    return undefined;
  }
}
