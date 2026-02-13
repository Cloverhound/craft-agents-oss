/**
 * App Webview Preload Script
 *
 * Minimal preload for custom app webviews that provides:
 * - A postMessage bridge to communicate with the host
 * - Exposes a `craftAgent` global for apps that don't use the SDK directly
 */

import { contextBridge, ipcRenderer } from 'electron'

function sendOpenUrlToHost(url: string): void {
  ipcRenderer.sendToHost('app-message', {
    type: 'APP_OPEN_URL',
    requestId: globalThis.crypto.randomUUID(),
    url,
  })
}

function shouldInterceptUrl(url: URL): boolean {
  // Keep in-app file navigation untouched, forward external/deep links to host shell.
  if (url.protocol === 'file:') return false
  return [ 'http:', 'https:', 'mailto:', 'craftagents:' ].includes(url.protocol)
}

function installAnchorInterceptor(): void {
  const handlePointerOpen = (event: MouseEvent): void => {
    if (event.defaultPrevented) return
    if (event.button !== 0 && event.button !== 1) return

    const target = event.target as HTMLElement | null
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
    if (!anchor) return
    if (!anchor.href) return

    let parsed: URL
    try {
      parsed = new URL(anchor.href, window.location.href)
    } catch {
      return
    }

    if (!shouldInterceptUrl(parsed)) return

    event.preventDefault()
    event.stopPropagation()
    sendOpenUrlToHost(parsed.toString())
  }

  window.addEventListener('click', handlePointerOpen, true)
  window.addEventListener('auxclick', handlePointerOpen, true)
}

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

installAnchorInterceptor()
