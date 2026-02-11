/**
 * AppsListPanel
 *
 * Panel component for displaying workspace custom apps in the sidebar.
 * Styled to match SkillsListPanel with avatar, title, and subtitle layout.
 */

import * as React from 'react'
import { useState } from 'react'
import { MoreHorizontal, LayoutGrid, Trash2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { DropdownMenuProvider } from '@/components/ui/menu-context'
import { cn } from '@/lib/utils'
import type { LoadedApp } from '@craft-agent/shared/apps'

export interface AppsListPanelProps {
  apps: LoadedApp[]
  onDeleteApp: (appSlug: string) => void
  onAppClick: (app: LoadedApp) => void
  selectedAppSlug?: string | null
  className?: string
}

export function AppsListPanel({
  apps,
  onDeleteApp,
  onAppClick,
  selectedAppSlug,
  className,
}: AppsListPanelProps) {
  // Empty state
  if (apps.length === 0) {
    return (
      <div className={cn('flex flex-col flex-1', className)}>
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGrid />
            </EmptyMedia>
            <EmptyTitle>No apps installed</EmptyTitle>
            <EmptyDescription>
              Custom apps are React micro-applications built by your agent. Ask your agent to create one.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      <ScrollArea className="flex-1">
        <div className="pb-2">
          <div className="pt-2">
            {apps.map((app, index) => (
              <AppItem
                key={app.config.slug}
                app={app}
                isSelected={selectedAppSlug === app.config.slug}
                isFirst={index === 0}
                onClick={() => onAppClick(app)}
                onDelete={() => onDeleteApp(app.config.slug)}
              />
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

interface AppItemProps {
  app: LoadedApp
  isSelected: boolean
  isFirst: boolean
  onClick: () => void
  onDelete: () => void
}

function AppItem({ app, isSelected, isFirst, onClick, onDelete }: AppItemProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="app-item" data-selected={isSelected || undefined}>
      {/* Separator - only show if not first */}
      {!isFirst && (
        <div className="app-separator pl-12 pr-4">
          <Separator />
        </div>
      )}
      {/* Wrapper for button + dropdown, group for hover state */}
      <div className="app-content relative group select-none pl-2 mr-2">
        {/* App Icon - positioned absolutely */}
        <div className="absolute left-[18px] top-3.5 z-10 flex items-center justify-center">
          <div className="w-5 h-5 flex items-center justify-center text-base shrink-0">
            {app.config.icon || '📦'}
          </div>
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
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            {/* Title - app name */}
            <div className="flex items-start gap-2 w-full pr-6 min-w-0">
              <div className="font-medium font-sans line-clamp-2 min-w-0 -mb-[2px]">
                {app.config.name}
              </div>
            </div>
            {/* Subtitle - description + build status */}
            <div className="flex items-center gap-1.5 text-xs text-foreground/70 w-full -mb-[2px] pr-6 min-w-0">
              {!app.isBuilt && (
                <span className="shrink-0 text-amber-500/80">Not built</span>
              )}
              {app.config.description && (
                <span className="truncate">
                  {app.config.description}
                </span>
              )}
            </div>
          </div>
        </button>
        {/* Action buttons - visible on hover or when menu is open */}
        <div
          className={cn(
            "absolute right-2 top-2 transition-opacity z-10",
            menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
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
                  <StyledDropdownMenuItem
                    variant="destructive"
                    onSelect={onDelete}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete App
                  </StyledDropdownMenuItem>
                </DropdownMenuProvider>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  )
}
