import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { runAppScript } from '../script-runner.ts';

describe('runAppScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'script-runner-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  function writeScript(name: string, content: string): string {
    const path = join(tempDir, name);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  it('returns parsed JSON from stdout', async () => {
    const scriptPath = writeScript('data.ts', `console.log(JSON.stringify({ count: 42 }));`);
    const result = await runAppScript({ scriptPath });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ count: 42 });
    expect(result.exitCode).toBe(0);
  });

  it('receives params via CRAFT_PARAMS env var', async () => {
    const scriptPath = writeScript(
      'echo-params.ts',
      `const params = JSON.parse(process.env.CRAFT_PARAMS || '{}');
console.log(JSON.stringify(params));`,
    );
    const result = await runAppScript({ scriptPath, params: { key: 'value' } });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ key: 'value' });
  });

  it('returns failure for non-zero exit code', async () => {
    const scriptPath = writeScript('fail.ts', `process.exit(1);`);
    const result = await runAppScript({ scriptPath });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('captures stderr', async () => {
    const scriptPath = writeScript(
      'stderr.ts',
      `console.error('something went wrong');
console.log(JSON.stringify({ ok: true }));`,
    );
    const result = await runAppScript({ scriptPath });
    expect(result.success).toBe(true);
    expect(result.stderr).toContain('something went wrong');
  });

  it('times out long-running scripts', async () => {
    const scriptPath = writeScript(
      'slow.ts',
      `await new Promise(r => setTimeout(r, 10000));
console.log(JSON.stringify({ done: true }));`,
    );
    const result = await runAppScript({ scriptPath, timeout: 500 });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('timed out');
    expect(result.exitCode).toBe(-1);
  });

  it('returns failure for invalid JSON output', async () => {
    const scriptPath = writeScript('bad-json.ts', `console.log('not json');`);
    const result = await runAppScript({ scriptPath });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Failed to parse');
  });

  it('passes env vars to child process', async () => {
    const scriptPath = writeScript(
      'env-check.ts',
      `console.log(JSON.stringify({ myVar: process.env.MY_VAR }));`,
    );
    const result = await runAppScript({ scriptPath, env: { MY_VAR: 'hello' } });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ myVar: 'hello' });
  });

  it('handles empty stdout as null result', async () => {
    const scriptPath = writeScript('empty.ts', ``);
    const result = await runAppScript({ scriptPath });
    expect(result.success).toBe(true);
    expect(result.result).toBeNull();
  });
});
