import { useState, useEffect, useCallback } from 'react'
import type { LoadedApp } from '@craft-agent/shared/apps'

export interface UseAppsResult {
  /** All custom apps for the workspace */
  apps: LoadedApp[]
  /** Whether apps are being loaded */
  isLoading: boolean
  /** Error message if loading failed */
  error: string | null
  /** Manually refresh apps list */
  refresh: () => Promise<void>
}

export function useApps(workspaceId: string | null): UseAppsResult {
  const [apps, setApps] = useState<LoadedApp[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setApps([])
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const result = await window.electronAPI.getApps(workspaceId)
      setApps(result)
      setError(null)
    } catch (err) {
      console.error('[useApps] Failed to load apps:', err)
      setError(err instanceof Error ? err.message : 'Failed to load apps')
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  // Load apps when workspace changes
  useEffect(() => {
    refresh()
  }, [refresh])

  // Subscribe to live app changes
  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onAppsChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        refresh()
      }
    })

    return cleanup
  }, [workspaceId, refresh])

  return {
    apps,
    isLoading,
    error,
    refresh,
  }
}
