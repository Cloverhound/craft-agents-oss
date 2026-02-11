/**
 * useAppNavigate Hook
 *
 * Navigate between views within the app.
 * Reads from shared AppProvider context so all components
 * see the same navigation state.
 */

import { useAppContext } from '../AppProvider.tsx';

export interface UseAppNavigateResult {
  /** Current view ID */
  currentView: string;
  /** Params for the current view */
  params: Record<string, string>;
  /** Navigate to a view, optionally with params */
  navigate: (viewId: string, params?: Record<string, string>) => void;
}

export function useAppNavigate(): UseAppNavigateResult {
  const ctx = useAppContext();
  return {
    currentView: ctx.currentView,
    params: ctx.params,
    navigate: ctx.navigate,
  };
}
