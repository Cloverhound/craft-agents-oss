/**
 * useAppData Hook
 *
 * Fetches data from an app script via the bridge.
 * Reactive to param changes by default.
 */

import { useState, useEffect, useCallback } from 'react';
import { getGlobalBridge } from '../bridge.ts';

export interface UseAppDataOptions {
  /** When false, the hook skips fetching and returns idle state. Default: true. */
  enabled?: boolean;
}

export interface UseAppDataResult<T = unknown> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useAppData<T = unknown>(
  scriptName: string,
  params?: Record<string, string>,
  options?: UseAppDataOptions,
): UseAppDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchCount, setFetchCount] = useState(0);

  const enabled = options?.enabled ?? true;
  const paramsKey = params ? JSON.stringify(params) : '';

  const refetch = useCallback(() => {
    setFetchCount((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const bridge = getGlobalBridge();
    bridge
      .sendToHost('APP_RUN_SCRIPT', { scriptName, params })
      .then((result) => {
        if (!cancelled) {
          setData(result as T);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [scriptName, paramsKey, fetchCount, enabled]);

  return { data, loading, error, refetch };
}
