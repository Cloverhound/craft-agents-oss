/**
 * CredentialMenu - Shared menu content for credential actions
 *
 * Used by:
 * - CredentialsListPanel (dropdown via "..." button, context menu via right-click)
 * - CredentialInfoPage (title dropdown menu)
 *
 * Uses MenuComponents context to render with either DropdownMenu or ContextMenu
 * primitives, allowing the same component to work in both scenarios.
 *
 * Provides consistent credential actions:
 * - Open in New Window
 * - Show Config in Finder
 * - Delete
 */

import * as React from 'react'
import {
  Trash2,
  FolderOpen,
  AppWindow,
} from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'

export interface CredentialMenuProps {
  /** Credential slug */
  credentialSlug: string
  /** Credential name for display */
  credentialName: string
  /** Callbacks */
  onOpenInNewWindow: () => void
  onShowInFinder: () => void
  onDelete: () => void
}

/**
 * CredentialMenu - Renders the menu items for credential actions
 * This is the content only, not wrapped in a DropdownMenu or ContextMenu
 */
export function CredentialMenu({
  credentialSlug,
  credentialName,
  onOpenInNewWindow,
  onShowInFinder,
  onDelete,
}: CredentialMenuProps) {
  // Get menu components from context (works with both DropdownMenu and ContextMenu)
  const { MenuItem, Separator } = useMenuComponents()

  return (
    <>
      {/* Open in New Window */}
      <MenuItem onClick={onOpenInNewWindow}>
        <AppWindow className="h-3.5 w-3.5" />
        <span className="flex-1">Open in New Window</span>
      </MenuItem>

      {/* Show Config in Finder */}
      <MenuItem onClick={onShowInFinder}>
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="flex-1">Show Config in Finder</span>
      </MenuItem>

      <Separator />

      {/* Delete */}
      <MenuItem onClick={onDelete} variant="destructive">
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1">Delete Credential</span>
      </MenuItem>
    </>
  )
}
