/**
 * AppHostPage
 *
 * Hosts a custom app in a sandboxed webview.
 * Manages the postMessage bridge between the app and the host.
 */

import * as React from 'react'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigation } from '@/contexts/NavigationContext'
import type { Route } from '../../shared/routes'
import type { LoadedApp } from '@craft-agent/shared/apps'
import { Loader2 } from 'lucide-react'

export interface AppHostPageProps {
  appSlug: string
  viewId?: string
  params?: Record<string, string>
  workspaceId: string
}

export default function AppHostPage({
  appSlug,
  viewId,
  params,
  workspaceId,
}: AppHostPageProps) {
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const [app, setApp] = useState<LoadedApp | null>(null)
  const [appLoading, setAppLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { navigate } = useNavigation()

  // Load app data
  useEffect(() => {
    let cancelled = false
    setAppLoading(true)

    window.electronAPI.getApps(workspaceId).then((apps) => {
      if (cancelled) return
      const found = apps.find((a: LoadedApp) => a.config.slug === appSlug)
      setApp(found || null)
      if (!found) {
        setError(`App "${appSlug}" not found`)
      }
      setAppLoading(false)
    }).catch((err) => {
      if (cancelled) return
      console.error('[AppHostPage] Failed to load app:', err)
      setError(err instanceof Error ? err.message : 'Failed to load app')
      setAppLoading(false)
    })

    return () => { cancelled = true }
  }, [workspaceId, appSlug])

  // Handle messages from the app webview
  const handleIpcMessage = useCallback(async (event: Electron.IpcMessageEvent) => {
    const { channel, args } = event
    if (channel !== 'app-message' || !args[0]) return

    const message = args[0] as {
      type: string
      requestId: string
      [key: string]: unknown
    }

    try {
      let response: Record<string, unknown>

      switch (message.type) {
        case 'APP_RUN_SCRIPT': {
          const scriptName = message.scriptName as string
          const scriptParams = message.params as Record<string, string> | undefined
          const result = await window.electronAPI.runAppScript(
            workspaceId,
            appSlug,
            scriptName,
            scriptParams,
          )
          response = {
            type: 'response',
            requestId: message.requestId,
            result: (result as { result?: unknown })?.result ?? result,
          }
          break
        }

        case 'APP_NAVIGATE': {
          // In-app navigation — handled by the app itself
          response = {
            type: 'response',
            requestId: message.requestId,
            result: { ok: true },
          }
          break
        }

        case 'APP_HOST_NAVIGATE': {
          const route = message.route as Route
          if (route && navigate) {
            navigate(route)
          }
          response = {
            type: 'response',
            requestId: message.requestId,
            result: { ok: true },
          }
          break
        }

        case 'APP_SET_MODE': {
          const requestedMode = message.mode as 'explore' | 'execute'
          const configMode = app?.config.mode ?? 'explore'

          // Can only switch to execute if the app's config allows it
          if (requestedMode === 'execute' && configMode !== 'execute') {
            response = {
              type: 'response',
              requestId: message.requestId,
              error: 'App config does not allow execute mode',
            }
          } else {
            await window.electronAPI.setAppMode(workspaceId, appSlug, requestedMode)
            response = {
              type: 'response',
              requestId: message.requestId,
              result: { ok: true, mode: requestedMode },
            }
          }
          break
        }

        default:
          response = {
            type: 'response',
            requestId: message.requestId,
            error: `Unknown message type: ${message.type}`,
          }
      }

      webviewRef.current?.send('host-message', response)
    } catch (err) {
      console.error(`[App:${appSlug}] IPC handler error for ${message.type}:`, err)
      const errorResponse = {
        type: 'response',
        requestId: message.requestId,
        error: err instanceof Error ? err.message : 'Unknown error',
      }
      webviewRef.current?.send('host-message', errorResponse)
    }
  }, [workspaceId, appSlug, navigate])

  // Set up webview event listeners
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    const onDidFinishLoad = () => {
      setLoading(false)
      setError(null)
    }

    const onDidFailLoad = (event: Electron.DidFailLoadEvent) => {
      setLoading(false)
      setError(`Failed to load app: ${event.errorDescription}`)
    }

    // Forward webview console messages to the host console for debugging
    const onConsoleMessage = (event: Electron.ConsoleMessageEvent) => {
      const prefix = `[App:${appSlug}]`
      switch (event.level) {
        case 0: console.log(prefix, event.message); break
        case 1: console.warn(prefix, event.message); break
        case 2: console.error(prefix, event.message); break
        default: console.log(prefix, event.message)
      }
    }

    // Detect webview renderer crashes
    const onCrashed = () => {
      console.error(`[App:${appSlug}] Webview renderer crashed`)
      setError('App crashed unexpectedly')
      setLoading(false)
    }

    webview.addEventListener('did-finish-load', onDidFinishLoad)
    webview.addEventListener('did-fail-load', onDidFailLoad)
    webview.addEventListener('ipc-message', handleIpcMessage)
    webview.addEventListener('console-message', onConsoleMessage)
    webview.addEventListener('crashed', onCrashed)

    return () => {
      webview.removeEventListener('did-finish-load', onDidFinishLoad)
      webview.removeEventListener('did-fail-load', onDidFailLoad)
      webview.removeEventListener('ipc-message', handleIpcMessage)
      webview.removeEventListener('console-message', onConsoleMessage)
      webview.removeEventListener('crashed', onCrashed)
    }
  }, [handleIpcMessage, app])

  // Loading state while fetching app data
  if (appLoading) {
    return (
      <div className="relative z-panel titlebar-no-drag flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-foreground/30" />
      </div>
    )
  }

  if (!app) {
    return (
      <div className="relative z-panel titlebar-no-drag flex items-center justify-center h-full text-foreground/50">
        <div className="text-center">
          <p className="text-sm font-medium">{error || 'App not found'}</p>
        </div>
      </div>
    )
  }

  if (!app.isBuilt) {
    return (
      <div className="relative z-panel titlebar-no-drag flex items-center justify-center h-full text-foreground/50">
        <div className="text-center">
          <p className="text-sm font-medium">App not built</p>
          <p className="text-xs mt-1">Ask your agent to compile this app first.</p>
        </div>
      </div>
    )
  }

  const appUrl = `file://${app.folderPath}/dist/index.html`

  return (
    <div className="relative z-panel titlebar-no-drag flex flex-col h-full w-full">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
          <Loader2 className="h-5 w-5 animate-spin text-foreground/30" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        </div>
      )}
      <webview
        ref={webviewRef as React.RefObject<Electron.WebviewTag>}
        src={appUrl}
        className="flex-1 w-full"
        webpreferences="contextIsolation=yes, nodeIntegration=no"
        preload={`file://${window.electronAPI.appPreloadPath}`}
      />
    </div>
  )
}
