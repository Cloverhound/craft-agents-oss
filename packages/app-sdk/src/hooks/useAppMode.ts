/**
 * useAppMode Hook
 *
 * Manage the app's permission mode (explore/execute).
 * Apps can switch modes at runtime if their config allows it.
 */

import { useState, useCallback } from 'react';
import { getGlobalBridge } from '../bridge.ts';

export type AppMode = 'explore' | 'execute';

export interface UseAppModeResult {
  /** Current permission mode */
  mode: AppMode;
  /** Switch to a different mode. Resolves with the new mode, or throws if denied. */
  switchMode: (newMode: AppMode) => Promise<AppMode>;
}

export function useAppMode(initialMode: AppMode = 'explore'): UseAppModeResult {
  const [mode, setMode] = useState<AppMode>(initialMode);

  const switchMode = useCallback(async (newMode: AppMode): Promise<AppMode> => {
    const bridge = getGlobalBridge();
    const result = await bridge.sendToHost('APP_SET_MODE', { mode: newMode }) as
      | { ok: true; mode: AppMode }
      | { error: string };

    if ('error' in result) {
      throw new Error(result.error);
    }

    setMode(result.mode);
    return result.mode;
  }, []);

  return { mode, switchMode };
}
