/**
 * QueueTaskMenu - Context/Dropdown menu for queue task items
 */

import { Trash2, Copy } from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'

export interface QueueTaskMenuProps {
  taskId: string
  taskTitle: string
  onDelete: () => void
}

export function QueueTaskMenu({ taskId, taskTitle, onDelete }: QueueTaskMenuProps) {
  const { MenuItem, Separator } = useMenuComponents()

  return (
    <>
      <MenuItem onClick={() => navigator.clipboard.writeText(taskId)}>
        <Copy className="h-3.5 w-3.5" />
        <span className="flex-1">Copy Task ID</span>
      </MenuItem>
      <Separator />
      <MenuItem onClick={onDelete}>
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1">Delete Task</span>
      </MenuItem>
    </>
  )
}
