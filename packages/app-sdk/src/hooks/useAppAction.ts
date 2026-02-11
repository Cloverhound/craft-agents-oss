/**
 * useAppAction Hook
 *
 * Runs a mutation script via the bridge.
 */

import { useState, useCallback } from 'react';
import { getGlobalBridge } from '../bridge.ts';

export interface UseAppActionResult<T = unknown> {
  execute: (params?: Record<string, string>) => Promise<T>;
  loading: boolean;
  error: string | null;
}

export function useAppAction<T = unknown>(scriptName: string): UseAppActionResult<T> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(
    async (params?: Record<string, string>): Promise<T> => {
      setLoading(true);
      setError(null);

      try {
        const bridge = getGlobalBridge();
        const result = await bridge.sendToHost('APP_RUN_SCRIPT', {
          scriptName,
          params,
          mutation: true,
        });
        setLoading(false);
        return result as T;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setLoading(false);
        throw err;
      }
    },
    [scriptName],
  );

  return { execute, loading, error };
}
