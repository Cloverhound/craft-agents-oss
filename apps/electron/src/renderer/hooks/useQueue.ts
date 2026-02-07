/**
 * useQueue Hook
 *
 * React hook to load and manage workspace queue data.
 * Fetches tasks, types, and stats via IPC.
 * Subscribes to live updates via QUEUE_CHANGED event.
 * Auto-refreshes when workspace changes.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { QueueTask, TaskTypeConfig, QueueStats, QueueTaskFilter } from '@craft-agent/shared/queue'

export interface UseQueueResult {
  /** Queue tasks matching the current filter */
  tasks: QueueTask[]
  /** All task types for the workspace */
  types: TaskTypeConfig[]
  /** Queue statistics */
  stats: QueueStats | null
  /** Whether data is loading */
  isLoading: boolean
  /** Error message if loading failed */
  error: string | null
  /** Manually refresh all queue data */
  refresh: () => Promise<void>
  /** Update a task (state transition, field edit) */
  updateTask: (taskId: string, updates: import('@craft-agent/shared/queue').UpdateTaskInput) => Promise<QueueTask | null>
  /** Delete a task */
  deleteTask: (taskId: string) => Promise<void>
}

/**
 * Load queue data for a workspace via IPC.
 * Auto-refreshes when workspaceId changes.
 * Subscribes to live queue changes via QUEUE_CHANGED event.
 */
export function useQueue(
  workspaceId: string | null,
  filter?: QueueTaskFilter
): UseQueueResult {
  const [tasks, setTasks] = useState<QueueTask[]>([])
  const [types, setTypes] = useState<TaskTypeConfig[]>([])
  const [stats, setStats] = useState<QueueStats | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Stable serialized filter for dependency tracking
  const filterKey = useMemo(() => JSON.stringify(filter ?? null), [filter])

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setTasks([])
      setTypes([])
      setStats(null)
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const [tasksResult, typesResult, statsResult] = await Promise.all([
        window.electronAPI.listQueueTasks(workspaceId, filter),
        window.electronAPI.listQueueTypes(workspaceId),
        window.electronAPI.getQueueStats(workspaceId),
      ])
      setTasks(tasksResult)
      setTypes(typesResult)
      setStats(statsResult)
      setError(null)
    } catch (err) {
      console.error('[useQueue] Failed to load queue data:', err)
      setError(err instanceof Error ? err.message : 'Failed to load queue data')
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId, filterKey])

  // Load queue data when workspace or filter changes
  useEffect(() => {
    refresh()
  }, [refresh])

  // Subscribe to live queue changes
  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onQueueChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        refresh()
      }
    })

    return cleanup
  }, [workspaceId, refresh])

  // Update a task via IPC
  const updateTask = useCallback(async (taskId: string, updates: import('@craft-agent/shared/queue').UpdateTaskInput): Promise<QueueTask | null> => {
    if (!workspaceId) return null
    try {
      const updated = await window.electronAPI.updateQueueTask(workspaceId, taskId, updates)
      return updated
    } catch (err) {
      console.error('[useQueue] Failed to update task:', err)
      return null
    }
  }, [workspaceId])

  // Delete a task via IPC
  const deleteTask = useCallback(async (taskId: string): Promise<void> => {
    if (!workspaceId) return
    try {
      await window.electronAPI.deleteQueueTask(workspaceId, taskId)
    } catch (err) {
      console.error('[useQueue] Failed to delete task:', err)
    }
  }, [workspaceId])

  return {
    tasks,
    types,
    stats,
    isLoading,
    error,
    refresh,
    updateTask,
    deleteTask,
  }
}
