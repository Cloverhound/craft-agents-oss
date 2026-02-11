/**
 * useHostNavigate Hook
 *
 * Navigate the host application (Craft Agent) from within an app.
 */

import { useCallback } from 'react';
import { getGlobalBridge } from '../bridge.ts';

export interface UseHostNavigateResult {
  navigate: (route: string) => void;
}

export function useHostNavigate(): UseHostNavigateResult {
  const navigate = useCallback((route: string) => {
    try {
      const bridge = getGlobalBridge();
      bridge.sendToHost('APP_HOST_NAVIGATE', { route }).catch(() => {
        // Fire-and-forget
      });
    } catch {
      // Bridge not initialized
    }
  }, []);

  return { navigate };
}
