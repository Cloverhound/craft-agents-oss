import { atom } from 'jotai'
import type { LoadedApp } from '@craft-agent/shared/apps'

/**
 * Atom to store the current workspace's custom apps.
 * Populated by useApps hook, read by AppShell sidebar and navigation.
 */
export const appsAtom = atom<LoadedApp[]>([])
