/**
 * App Bridge
 *
 * Communication bridge between app webview and host process.
 * Uses injectable transport for testability.
 */

// Use globalThis.crypto.randomUUID() for browser+Node compatibility
const generateId = (): string => globalThis.crypto.randomUUID();

// ============================================================
// Types
// ============================================================

export interface BridgeMessage {
  type: string;
  requestId: string;
  [key: string]: unknown;
}

export interface BridgeTransport {
  send(message: BridgeMessage): void;
  onMessage(handler: (message: BridgeMessage) => void): () => void;
}

export interface Bridge {
  sendToHost(type: string, payload?: Record<string, unknown>): Promise<unknown>;
  onHostMessage(type: string, handler: (message: BridgeMessage) => void): () => void;
}

// ============================================================
// Transport Implementations
// ============================================================

/**
 * Production transport using window.postMessage (for iframe-based hosting).
 */
export function createPostMessageTransport(): BridgeTransport {
  return {
    send(message: BridgeMessage) {
      window.parent.postMessage(message, '*');
    },
    onMessage(handler: (message: BridgeMessage) => void): () => void {
      const listener = (event: MessageEvent) => {
        if (event.data && typeof event.data === 'object' && event.data.type) {
          handler(event.data as BridgeMessage);
        }
      };
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
  };
}

/**
 * Electron webview transport using the preload-exposed window.craftAgent API.
 * Used when the app runs in an Electron <webview> with the app-preload script.
 */
export function createWebviewTransport(): BridgeTransport {
  const craftAgent = (window as any).craftAgent;
  if (!craftAgent) {
    throw new Error('window.craftAgent not available — is the app-preload script loaded?');
  }

  return {
    send(message: BridgeMessage) {
      craftAgent.sendToHost(message);
    },
    onMessage(handler: (message: BridgeMessage) => void): () => void {
      return craftAgent.onHostMessage((message: BridgeMessage) => {
        handler(message);
      });
    },
  };
}

/**
 * Auto-detect the correct transport and initialize the global bridge.
 * Call this before rendering the React app.
 *
 * Detection order:
 * 1. window.craftAgent (Electron webview with app-preload)
 * 2. window.parent !== window (iframe — use postMessage)
 * 3. Fallback to postMessage
 */
export function initAppSdk(): Bridge {
  let transport: BridgeTransport;

  if ((window as any).craftAgent) {
    transport = createWebviewTransport();
  } else {
    transport = createPostMessageTransport();
  }

  const bridge = createBridge(transport);
  setGlobalBridge(bridge);
  return bridge;
}

/**
 * In-memory transport for testing.
 */
export function createMockTransport(): {
  transport: BridgeTransport;
  simulateResponse: (message: BridgeMessage) => void;
  getSentMessages: () => BridgeMessage[];
} {
  const handlers: Set<(message: BridgeMessage) => void> = new Set();
  const sentMessages: BridgeMessage[] = [];

  return {
    transport: {
      send(message: BridgeMessage) {
        sentMessages.push(message);
      },
      onMessage(handler: (message: BridgeMessage) => void): () => void {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
    simulateResponse(message: BridgeMessage) {
      for (const handler of handlers) {
        handler(message);
      }
    },
    getSentMessages() {
      return sentMessages;
    },
  };
}

// ============================================================
// Bridge Implementation
// ============================================================

/**
 * Create a bridge instance with the given transport.
 */
export function createBridge(transport: BridgeTransport): Bridge {
  const pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const messageHandlers = new Map<string, Set<(message: BridgeMessage) => void>>();

  // Listen for responses
  transport.onMessage((message) => {
    // Check if this is a response to a pending request
    if (message.requestId && pendingRequests.has(message.requestId)) {
      const pending = pendingRequests.get(message.requestId)!;
      pendingRequests.delete(message.requestId);

      if (message.error) {
        pending.reject(new Error(String(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Route to type-specific handlers
    const handlers = messageHandlers.get(message.type);
    if (handlers) {
      for (const handler of handlers) {
        handler(message);
      }
    }
  });

  return {
    sendToHost(type: string, payload?: Record<string, unknown>): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const requestId = generateId();
        pendingRequests.set(requestId, { resolve, reject });
        transport.send({ type, requestId, ...payload });
      });
    },

    onHostMessage(type: string, handler: (message: BridgeMessage) => void): () => void {
      if (!messageHandlers.has(type)) {
        messageHandlers.set(type, new Set());
      }
      messageHandlers.get(type)!.add(handler);
      return () => messageHandlers.get(type)?.delete(handler);
    },
  };
}

// Global bridge instance (set by SDK initialization)
let globalBridge: Bridge | null = null;

export function setGlobalBridge(bridge: Bridge): void {
  globalBridge = bridge;
}

export function getGlobalBridge(): Bridge {
  if (!globalBridge) {
    throw new Error('App SDK bridge not initialized. Call initAppSdk() first.');
  }
  return globalBridge;
}
