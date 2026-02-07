import { atom } from 'jotai'
import type { QueueTask, TaskTypeConfig, QueueStats } from '@craft-agent/shared/queue'

/** All queue tasks (filtered by current view) */
export const queueTasksAtom = atom<QueueTask[]>([])

/** All queue task types for the workspace */
export const queueTypesAtom = atom<TaskTypeConfig[]>([])

/** Queue statistics (total, by category, by type) */
export const queueStatsAtom = atom<QueueStats | null>(null)

/** Currently selected task ID in the queue view */
export const queueSelectedTaskIdAtom = atom<string | null>(null)

/** Current type filter slug (null = show all types) */
export const queueTypeFilterAtom = atom<string | null>(null)
