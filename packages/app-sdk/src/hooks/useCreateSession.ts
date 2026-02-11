/**
 * useCreateSession Hook
 *
 * Create a new agent session with context data from within an app.
 * The session is created, data files are written to its data/ folder,
 * and the host navigates to the new session.
 */

import { useState, useCallback } from 'react';
import { getGlobalBridge } from '../bridge.ts';

export interface CreateSessionOptions {
  /** Session display name */
  name?: string;
  /** Permission mode ('safe' | 'ask' | 'allow-all') */
  mode?: 'safe' | 'ask' | 'allow-all';
  /** Working directory ('user_default' | 'none' | absolute path) */
  workdir?: string;
  /** Model override (e.g., 'haiku', 'sonnet') */
  model?: string;
  /** Data files to write into the session's data/ folder. Keys are filenames, values are JSON-serializable content. */
  data?: Record<string, unknown>;
  /** Message to pre-fill in the chat input (not sent automatically unless autoSend is true) */
  message?: string;
  /** When true, message is sent immediately instead of pre-filling the input. Default: false */
  autoSend?: boolean;
  /** Status (todo state) to apply */
  status?: string;
  /** Label to apply */
  label?: string;
}

export interface CreateSessionResult {
  ok: true;
  sessionId: string;
}

export interface UseCreateSessionResult {
  createSession: (options: CreateSessionOptions) => Promise<CreateSessionResult>;
  loading: boolean;
  error: string | null;
}

export function useCreateSession(): UseCreateSessionResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createSession = useCallback(
    async (options: CreateSessionOptions): Promise<CreateSessionResult> => {
      setLoading(true);
      setError(null);

      try {
        const bridge = getGlobalBridge();
        const result = await bridge.sendToHost('APP_CREATE_SESSION_WITH_CONTEXT', { ...options });
        setLoading(false);
        return result as CreateSessionResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setLoading(false);
        throw err;
      }
    },
    [],
  );

  return { createSession, loading, error };
}
