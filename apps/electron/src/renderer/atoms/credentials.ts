/**
 * Credentials Atom
 *
 * Simple atom for storing workspace credential configs.
 * Used by NavigationContext for auto-selection when navigating to credentials view.
 */

import { atom } from 'jotai'
import type { LoadedCredentialConfig } from '../../shared/types'

/**
 * Atom to store the current workspace's credential configs.
 * AppShell populates this when credentials are loaded.
 * NavigationContext reads from it for auto-selection.
 */
export const credentialsAtom = atom<LoadedCredentialConfig[]>([])
