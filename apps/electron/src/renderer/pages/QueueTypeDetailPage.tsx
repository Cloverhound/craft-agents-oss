/**
 * QueueTypeDetailPage
 *
 * Displays detailed information about a queue task type.
 * Shows type metadata, field schema, lifecycle states, and task count.
 * Uses the Info_ component system for consistent styling.
 */

import * as React from 'react'
import { useEffect, useState } from 'react'
import {
  Info_Page,
  Info_Section,
  Info_Table,
} from '@/components/info'
import type { TaskTypeConfig, QueueStats } from '@craft-agent/shared/queue'

interface QueueTypeDetailPageProps {
  typeSlug: string
  workspaceId: string
}

/**
 * Format a timestamp to a locale date string
 */
function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString()
}

export default function QueueTypeDetailPage({ typeSlug, workspaceId }: QueueTypeDetailPageProps) {
  const [taskType, setTaskType] = useState<TaskTypeConfig | null>(null)
  const [stats, setStats] = useState<QueueStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true
    setLoading(true)
    setError(null)

    const load = async () => {
      try {
        const [tt, s] = await Promise.all([
          window.electronAPI.getQueueType(workspaceId, typeSlug),
          window.electronAPI.getQueueStats(workspaceId),
        ])
        if (!isMounted) return

        if (!tt) {
          setError('Task type not found')
          setLoading(false)
          return
        }
        setTaskType(tt)
        setStats(s)
      } catch (err) {
        if (!isMounted) return
        setError(err instanceof Error ? err.message : 'Failed to load task type')
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    load()

    const unsubscribe = window.electronAPI.onQueueChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        load()
      }
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [workspaceId, typeSlug])

  // Build metadata table rows
  const metadataRows: [string, string][] = []
  if (taskType) {
    metadataRows.push(['Name', taskType.name])
    metadataRows.push(['Slug', taskType.slug])
    metadataRows.push(['Description', taskType.description])
    if (taskType.icon) {
      metadataRows.push(['Icon', taskType.icon])
    }
    if (taskType.tagline) {
      metadataRows.push(['Tagline', taskType.tagline])
    }
    if (taskType.source) {
      metadataRows.push(['Source', taskType.source])
    }
    metadataRows.push(['Created', formatTimestamp(taskType.createdAt)])
    metadataRows.push(['Updated', formatTimestamp(taskType.updatedAt)])
  }

  // Build field schema table rows
  const fieldRows: [string, string][] = []
  if (taskType) {
    for (const [key, field] of Object.entries(taskType.fields)) {
      const required = field.required ? ' (required)' : ''
      fieldRows.push([field.label || key, `${field.type}${required}`])
    }
  }

  // Build states table rows
  const stateRows: [string, string][] = []
  if (taskType) {
    for (const state of taskType.states) {
      const markers: string[] = [state.category]
      if (state.isDefault) markers.push('default')
      stateRows.push([state.label, markers.join(', ')])
    }
  }

  // Get type stats
  const typeStats = stats?.byType[typeSlug]

  return (
    <Info_Page loading={loading} error={error || undefined}>
      <Info_Page.Header
        title={taskType ? `${taskType.icon ? taskType.icon + ' ' : ''}${taskType.name}` : 'Task Type'}
      />
      {taskType && (
        <Info_Page.Content>
          {/* Task Counts */}
          {typeStats && (
            <Info_Section title="Tasks">
              <div className="flex gap-4 text-sm">
                <div>
                  <span className="text-foreground/50">Total:</span>{' '}
                  <span className="font-medium">{typeStats.total}</span>
                </div>
                <div>
                  <span className="text-foreground/50">Open:</span>{' '}
                  <span className="font-medium text-info">{typeStats.open}</span>
                </div>
                <div>
                  <span className="text-foreground/50">Closed:</span>{' '}
                  <span className="font-medium text-success">{typeStats.closed}</span>
                </div>
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

          {/* Lifecycle States */}
          {stateRows.length > 0 && (
            <Info_Section title="Lifecycle States">
              <Info_Table>
                {stateRows.map(([label, value]) => (
                  <Info_Table.Row key={label} label={label} value={value} />
                ))}
              </Info_Table>
            </Info_Section>
          )}

          {/* Field Schema */}
          {fieldRows.length > 0 && (
            <Info_Section title="Field Schema">
              <Info_Table>
                {fieldRows.map(([label, value]) => (
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
