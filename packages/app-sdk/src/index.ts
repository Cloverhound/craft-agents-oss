/**
 * @craft-agent/app-sdk
 *
 * SDK for building custom apps within Craft Agent.
 */

// Bridge
export {
  createBridge,
  createPostMessageTransport,
  createWebviewTransport,
  createMockTransport,
  setGlobalBridge,
  getGlobalBridge,
  initAppSdk,
} from './bridge.ts';
export type { Bridge, BridgeTransport, BridgeMessage } from './bridge.ts';

// App Context (shared navigation state)
export { AppProvider, useAppContext } from './AppProvider.tsx';
export type { AppProviderProps, AppContextValue, NavigationState } from './AppProvider.tsx';

// Hooks
export { useAppData } from './hooks/useAppData.ts';
export type { UseAppDataResult, UseAppDataOptions } from './hooks/useAppData.ts';
export { useAppAction } from './hooks/useAppAction.ts';
export type { UseAppActionResult } from './hooks/useAppAction.ts';
export { useAppNavigate } from './hooks/useAppNavigate.ts';
export type { UseAppNavigateResult } from './hooks/useAppNavigate.ts';
export { useHostNavigate } from './hooks/useHostNavigate.ts';
export type { UseHostNavigateResult } from './hooks/useHostNavigate.ts';
export { useTheme } from './hooks/useTheme.ts';
export type { AppTheme } from './hooks/useTheme.ts';
export { useAppMode } from './hooks/useAppMode.ts';
export type { AppMode, UseAppModeResult } from './hooks/useAppMode.ts';
export { useCreateSession } from './hooks/useCreateSession.ts';
export type { CreateSessionOptions, CreateSessionResult, UseCreateSessionResult } from './hooks/useCreateSession.ts';
export { useOpenUrl } from './hooks/useOpenUrl.ts';

// Components
export { Table, Badge, Button, Card, EmptyState, Spinner } from './components/index.ts';
