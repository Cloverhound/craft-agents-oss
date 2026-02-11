/**
 * AppProvider
 *
 * React Context provider for shared app state.
 * Wraps the app to provide:
 * - Shared navigation state (current view + params)
 * - Bridge-backed host communication for navigation events
 *
 * Usage:
 *   <AppProvider defaultView="list">
 *     <App />
 *   </AppProvider>
 */

import React, { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { getGlobalBridge } from './bridge.ts';

// ============================================================
// Types
// ============================================================

export interface NavigationState {
  /** Current view ID */
  currentView: string;
  /** Params for the current view */
  params: Record<string, string>;
}

export interface AppContextValue extends NavigationState {
  /** Navigate to a view, optionally with params */
  navigate: (viewId: string, params?: Record<string, string>) => void;
}

// ============================================================
// Context
// ============================================================

const AppContext = createContext<AppContextValue | null>(null);

// ============================================================
// Provider
// ============================================================

export interface AppProviderProps {
  children: ReactNode;
  /** The initial view to show (defaults to 'default') */
  defaultView?: string;
}

export function AppProvider({ children, defaultView = 'default' }: AppProviderProps) {
  const [navState, setNavState] = useState<NavigationState>({
    currentView: defaultView,
    params: {},
  });

  const navigate = useCallback((viewId: string, params?: Record<string, string>) => {
    setNavState({ currentView: viewId, params: params ?? {} });

    // Notify the host (fire-and-forget)
    try {
      const bridge = getGlobalBridge();
      bridge.sendToHost('APP_NAVIGATE', { viewId, params }).catch(() => {});
    } catch {
      // Bridge not initialized yet — local state still updates
    }
  }, []);

  const value: AppContextValue = {
    currentView: navState.currentView,
    params: navState.params,
    navigate,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

// ============================================================
// Hook
// ============================================================

/**
 * Access the shared app navigation context.
 * Must be used within an <AppProvider>.
 */
export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useAppContext must be used within an <AppProvider>');
  }
  return ctx;
}
