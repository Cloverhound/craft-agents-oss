/**
 * QueueListPanel
 *
 * Panel component for displaying workspace queue tasks in the 2nd sidebar.
 * Styled to match SourcesListPanel with title, state badge, and priority layout.
 */

import * as React from 'react'
import { useState } from 'react'
import { MoreHorizontal, ListTodo, Circle, CheckCircle2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
} from '@/components/ui/styled-dropdown'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
} from '@/components/ui/styled-context-menu'
import { DropdownMenuProvider, ContextMenuProvider } from '@/components/ui/menu-context'
import { QueueTaskMenu } from './QueueTaskMenu'
import { cn } from '@/lib/utils'
import type { QueueTask, TaskTypeConfig, QueueStats } from '@craft-agent/shared/queue'

export interface QueueListPanelProps {
  tasks: QueueTask[]
  types: TaskTypeConfig[]
  stats: QueueStats | null
  /** Filter by task type slug */
  typeFilter?: string | null
  onTaskClick: (task: QueueTask) => void
  onDeleteTask: (taskId: string) => void
  selectedTaskId?: string | null
  className?: string
}

/**
 * Get the TaskTypeConfig for a given type slug
 */
function getTypeForTask(types: TaskTypeConfig[], typeSlug: string): TaskTypeConfig | undefined {
  return types.find(t => t.slug === typeSlug)
}

/**
 * Get the state config for a task's current state
 */
function getStateConfig(types: TaskTypeConfig[], task: QueueTask) {
  const taskType = getTypeForTask(types, task.typeSlug)
  if (!taskType) return null
  return taskType.states.find(s => s.id === task.state) || null
}

/**
 * Get state badge styling based on category
 */
function getStateBadgeClasses(category: 'open' | 'closed'): string {
  return category === 'open'
    ? 'bg-info/10 text-info'
    : 'bg-success/10 text-success'
}

/**
 * Format relative time from timestamp
 */
function formatAge(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  return `${months}mo`
}

export function QueueListPanel({
  tasks,
  types,
  stats,
  typeFilter,
  onTaskClick,
  onDeleteTask,
  selectedTaskId,
  className,
}: QueueListPanelProps) {
  // Filter tasks by type if filter is active
  const filteredTasks = React.useMemo(() => {
    if (!typeFilter) return tasks
    return tasks.filter(t => t.typeSlug === typeFilter)
  }, [tasks, typeFilter])

  // Empty state
  if (filteredTasks.length === 0) {
    return (
      <Empty className={cn('flex-1', className)}>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListTodo />
          </EmptyMedia>
          <EmptyTitle>
            {typeFilter
              ? 'No tasks of this type yet'
              : 'No queue tasks yet'}
          </EmptyTitle>
          <EmptyDescription>
            Tasks are created by agents via queue tools during chat sessions.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div className="pb-2">
        <div className="pt-2">
          {filteredTasks.map((task, index) => (
            <QueueTaskItem
              key={task.id}
              task={task}
              types={types}
              isSelected={selectedTaskId === task.id}
              isFirst={index === 0}
              onClick={() => onTaskClick(task)}
              onDelete={() => onDeleteTask(task.id)}
            />
          ))}
        </div>
      </div>
    </ScrollArea>
  )
}

interface QueueTaskItemProps {
  task: QueueTask
  types: TaskTypeConfig[]
  isSelected: boolean
  isFirst: boolean
  onClick: () => void
  onDelete: () => void
}

function QueueTaskItem({ task, types, isSelected, isFirst, onClick, onDelete }: QueueTaskItemProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)

  const stateConfig = getStateConfig(types, task)
  const taskType = getTypeForTask(types, task.typeSlug)
  const stateCategory = stateConfig?.category || 'open'

  return (
    <div className="queue-task-item" data-selected={isSelected || undefined}>
      {/* Separator - only show if not first */}
      {!isFirst && (
        <div className="pl-12 pr-4">
          <Separator />
        </div>
      )}
      <ContextMenu modal={true} onOpenChange={setContextMenuOpen}>
        <ContextMenuTrigger asChild>
          <div className="relative group select-none pl-2 mr-2">
            {/* State icon - positioned absolutely */}
            <div className="absolute left-[18px] top-3.5 z-10 flex items-center justify-center">
              {stateCategory === 'closed' ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <Circle className="h-4 w-4 text-info" />
              )}
            </div>
            {/* Main content button */}
            <button
              className={cn(
                "flex w-full items-start gap-2 pl-2 pr-4 py-3 text-left text-sm transition-all outline-none rounded-[8px]",
                isSelected
                  ? "bg-foreground/5 hover:bg-foreground/7"
                  : "hover:bg-foreground/2"
              )}
              onClick={onClick}
            >
              {/* Spacer for icon */}
              <div className="w-5 h-5 shrink-0" />
              {/* Content column */}
              <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                {/* Title */}
                <div className="flex items-start gap-2 w-full pr-6 min-w-0">
                  <div className="font-medium font-sans line-clamp-2 min-w-0 -mb-[2px]">
                    {task.title}
                  </div>
                </div>
                {/* Subtitle: type badge + state badge + age */}
                <div className="flex items-center gap-1.5 text-xs text-foreground/70 w-full -mb-[2px] pr-6 min-w-0">
                  {/* Type badge */}
                  {taskType && (
                    <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent/10 text-accent">
                      {taskType.icon ? `${taskType.icon} ` : ''}{taskType.name}
                    </span>
                  )}
                  {/* State badge */}
                  {stateConfig && (
                    <span className={cn(
                      "shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded",
                      getStateBadgeClasses(stateConfig.category)
                    )}>
                      {stateConfig.label}
                    </span>
                  )}
                  {/* Priority */}
                  {task.priority != null && task.priority > 0 && (
                    <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-warning/10 text-warning">
                      P{task.priority}
                    </span>
                  )}
                  {/* Age */}
                  <span className="truncate text-foreground/40">
                    {formatAge(task.createdAt)}
                  </span>
                </div>
              </div>
            </button>
            {/* Action buttons - visible on hover */}
            <div
              className={cn(
                "absolute right-2 top-2 transition-opacity z-10",
                menuOpen || contextMenuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
            >
              <div className="flex items-center rounded-[8px] overflow-hidden border border-transparent hover:border-border/50">
                <DropdownMenu modal={true} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <div className="p-1.5 hover:bg-foreground/10 data-[state=open]:bg-foreground/10 cursor-pointer">
                      <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </DropdownMenuTrigger>
                  <StyledDropdownMenuContent align="end">
                    <DropdownMenuProvider>
                      <QueueTaskMenu
                        taskId={task.id}
                        taskTitle={task.title}
                        onDelete={onDelete}
                      />
                    </DropdownMenuProvider>
                  </StyledDropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        {/* Context menu */}
        <StyledContextMenuContent>
          <ContextMenuProvider>
            <QueueTaskMenu
              taskId={task.id}
              taskTitle={task.title}
              onDelete={onDelete}
            />
          </ContextMenuProvider>
        </StyledContextMenuContent>
      </ContextMenu>
    </div>
  )
}
