/**
 * QueueTaskDetailPage
 *
 * Displays detailed information about a single queue task.
 * Shows task fields, state transitions, labels, and linked sessions.
 * Uses the Info_ component system for consistent styling.
 */

import * as React from 'react'
import { useEffect, useState, useCallback } from 'react'
import { Trash2 } from 'lucide-react'
import {
  Info_Page,
  Info_Section,
  Info_Table,
} from '@/components/info'
import { cn } from '@/lib/utils'
import type { QueueTask, TaskTypeConfig } from '@craft-agent/shared/queue'

interface QueueTaskDetailPageProps {
  taskId: string
  workspaceId: string
}

/**
 * Format a timestamp to a locale date string
 */
function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString()
}

export default function QueueTaskDetailPage({ taskId, workspaceId }: QueueTaskDetailPageProps) {
  const [task, setTask] = useState<QueueTask | null>(null)
  const [taskType, setTaskType] = useState<TaskTypeConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load task data
  useEffect(() => {
    let isMounted = true
    setLoading(true)
    setError(null)

    const loadTask = async () => {
      try {
        const t = await window.electronAPI.getQueueTask(workspaceId, taskId)
        if (!isMounted) return

        if (!t) {
          setError('Task not found')
          setLoading(false)
          return
        }
        setTask(t)

        // Load the task type
        const tt = await window.electronAPI.getQueueType(workspaceId, t.typeSlug)
        if (!isMounted) return
        setTaskType(tt)
      } catch (err) {
        if (!isMounted) return
        setError(err instanceof Error ? err.message : 'Failed to load task')
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    loadTask()

    // Subscribe to queue changes for live updates
    const unsubscribe = window.electronAPI.onQueueChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        loadTask()
      }
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [workspaceId, taskId])

  // Handle state transition
  const handleStateChange = useCallback(async (newState: string) => {
    if (!task) return
    try {
      const updated = await window.electronAPI.updateQueueTask(workspaceId, taskId, { state: newState })
      setTask(updated)
    } catch (err) {
      console.error('[QueueTaskDetailPage] Failed to update state:', err)
    }
  }, [workspaceId, taskId, task])

  // Handle delete
  const handleDelete = useCallback(async () => {
    try {
      await window.electronAPI.deleteQueueTask(workspaceId, taskId)
    } catch (err) {
      console.error('[QueueTaskDetailPage] Failed to delete task:', err)
    }
  }, [workspaceId, taskId])

  // Get current state config
  const currentState = taskType?.states.find(s => s.id === task?.state)

  // Build metadata table rows
  const metadataRows: [string, string][] = []
  if (task) {
    metadataRows.push(['ID', task.id])
    metadataRows.push(['Type', taskType?.name || task.typeSlug])
    metadataRows.push(['State', currentState?.label || task.state])
    metadataRows.push(['Category', currentState?.category || 'open'])
    if (task.priority != null) {
      metadataRows.push(['Priority', `P${task.priority}`])
    }
    metadataRows.push(['Created', formatTimestamp(task.createdAt)])
    metadataRows.push(['Updated', formatTimestamp(task.updatedAt)])
    if (task.completedAt) {
      metadataRows.push(['Completed', formatTimestamp(task.completedAt)])
    }
    metadataRows.push(['Created By', task.createdBy])
    if (task.labels.length > 0) {
      metadataRows.push(['Labels', task.labels.join(', ')])
    }
    if (task.sourceSessionId) {
      metadataRows.push(['Source Session', task.sourceSessionId])
    }
    if (task.linkedSessionIds.length > 0) {
      metadataRows.push(['Linked Sessions', task.linkedSessionIds.join(', ')])
    }
  }

  // Build data fields table rows
  const dataRows: [string, string][] = []
  if (task && taskType) {
    for (const [key, fieldDef] of Object.entries(taskType.fields)) {
      const value = task.data[key]
      const displayValue = value == null ? '' :
        typeof value === 'object' ? JSON.stringify(value, null, 2) :
        String(value)
      dataRows.push([fieldDef.label || key, displayValue])
    }
  }

  return (
    <Info_Page loading={loading} error={error || undefined}>
      <Info_Page.Header
        title={task?.title || 'Task'}
        actions={
          <button
            onClick={handleDelete}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-[6px] text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        }
      />
      {task && (
        <Info_Page.Content>
          {/* State Transitions */}
          {taskType && taskType.states.length > 1 && (
            <Info_Section title="State">
              <div className="flex flex-wrap gap-1.5">
                {taskType.states.map(state => (
                  <button
                    key={state.id}
                    onClick={() => handleStateChange(state.id)}
                    className={cn(
                      "inline-flex items-center h-7 px-2.5 text-xs font-medium rounded-[6px] transition-colors",
                      state.id === task.state
                        ? "bg-foreground/10 text-foreground"
                        : "bg-foreground/[0.03] text-foreground/60 hover:bg-foreground/[0.06]"
                    )}
                  >
                    {state.label}
                  </button>
                ))}
              </div>
            </Info_Section>
          )}

          {/* Metadata */}
          <Info_Section title="Details">
            <Info_Table>
              {metadataRows.map(([label, value]) => (
                <Info_Table.Row key={label} label={label} value={value} />
              ))}
            </Info_Table>
          </Info_Section>

          {/* Data Fields */}
          {dataRows.length > 0 && (
            <Info_Section title="Fields">
              <Info_Table>
                {dataRows.map(([label, value]) => (
                  <Info_Table.Row key={label} label={label} value={value} />
                ))}
              </Info_Table>
            </Info_Section>
          )}
        </Info_Page.Content>
      )}
    </Info_Page>
  )
}
