/**
 * App Webview Preload Script
 *
 * Minimal preload for custom app webviews that provides:
 * - A postMessage bridge to communicate with the host
 * - Exposes a `craftAgent` global for apps that don't use the SDK directly
 */

import { contextBridge, ipcRenderer } from 'electron'

/**
 * Exposed API for custom apps running inside webviews.
 * Apps typically use the SDK hooks rather than calling this directly,
 * but it's available for advanced use cases.
 */
const appAPI = {
  /**
   * Send a message to the host application.
   * The host will route it based on `message.type`.
   */
  sendToHost: (message: { type: string; requestId: string; [key: string]: unknown }) => {
    ipcRenderer.sendToHost('app-message', message)
  },

  /**
   * Listen for messages from the host application.
   * Returns a cleanup function to remove the listener.
   */
  onHostMessage: (callback: (message: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: Record<string, unknown>) => {
      callback(message)
    }
    ipcRenderer.on('host-message', handler)
    return () => {
      ipcRenderer.removeListener('host-message', handler)
    }
  },
}

contextBridge.exposeInMainWorld('craftAgent', appAPI)
