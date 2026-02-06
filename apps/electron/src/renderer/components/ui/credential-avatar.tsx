/**
 * CredentialAvatar - Thin wrapper around EntityIcon for credentials.
 *
 * Sets fallbackIcon={KeyRound} and delegates all rendering to EntityIcon.
 * Use `fluid` prop for fill-parent sizing (e.g., Info_Page.Hero).
 */

import { useMemo } from 'react'
import { KeyRound } from 'lucide-react'
import { EntityIcon } from '@/components/ui/entity-icon'
import type { IconSize, ResolvedEntityIcon } from '@craft-agent/shared/icons'
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
}

export function CredentialAvatar({ credential, size = 'md', fluid, className }: CredentialAvatarProps) {
  const icon: ResolvedEntityIcon = useMemo(() => {
    if (credential.icon) {
      return { kind: 'emoji', value: credential.icon, colorable: false }
    }
    return { kind: 'fallback', colorable: false }
  }, [credential.icon])

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
