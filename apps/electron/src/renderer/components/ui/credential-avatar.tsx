/**
 * CredentialAvatar - Thin wrapper around EntityIcon for credentials.
 *
 * Sets fallbackIcon={KeyRound} and delegates all rendering to EntityIcon.
 * Uses useEntityIcon hook to properly handle emoji icons, URL icons, and fallbacks.
 * Use `fluid` prop for fill-parent sizing (e.g., Info_Page.Hero).
 */

import { KeyRound } from 'lucide-react'
import { EntityIcon } from '@/components/ui/entity-icon'
import { useEntityIcon } from '@/lib/icon-cache'
import type { IconSize } from '@craft-agent/shared/icons'
import type { LoadedCredentialConfig } from '../../../shared/types'

interface CredentialAvatarProps {
  /** LoadedCredentialConfig object */
  credential: LoadedCredentialConfig
  /** Size variant */
  size?: IconSize
  /** Fill parent container (h-full w-full). Overrides size. */
  fluid?: boolean
  /** Additional className overrides */
  className?: string
  /** Workspace ID for icon loading */
  workspaceId?: string
}

export function CredentialAvatar({ credential, size = 'md', fluid, className, workspaceId }: CredentialAvatarProps) {
  const icon = useEntityIcon({
    workspaceId: workspaceId ?? '',
    entityType: 'credential',
    identifier: credential.slug,
    iconValue: credential.icon,
  })

  return (
    <EntityIcon
      icon={icon}
      size={size}
      fallbackIcon={KeyRound}
      alt={credential.name}
      className={className}
      containerClassName={fluid ? 'h-full w-full' : undefined}
    />
  )
}
