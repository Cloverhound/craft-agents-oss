/**
 * useOpenUrl Hook
 *
 * Open an external URL from within an app (via the host shell).
 */

import { useCallback } from 'react';
import { getGlobalBridge } from '../bridge.ts';

export function useOpenUrl() {
  const openUrl = useCallback((url: string) => {
    try {
      const bridge = getGlobalBridge();
      bridge.sendToHost('APP_OPEN_URL', { url }).catch(() => {
        // Fire-and-forget
      });
    } catch {
      // Bridge not initialized
    }
  }, []);

  return { openUrl };
}
