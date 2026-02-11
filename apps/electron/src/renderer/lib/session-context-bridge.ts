/**
 * Session Context Bridge
 *
 * Handles the APP_CREATE_SESSION_WITH_CONTEXT bridge message from custom apps.
 * Creates a session, writes context data to its data/ folder, and navigates to it.
 *
 * This module exists as an additive file to keep AppHostPage.tsx changes minimal
 * and reduce merge conflicts with upstream. (craft-agents-oss-development skill)
 */

import type { Route } from '../../shared/routes'
import type { CreateSessionOptions } from '../../shared/types'

/** Payload shape for APP_CREATE_SESSION_WITH_CONTEXT bridge messages */
export interface CreateSessionWithContextPayload {
  /** Session display name */
  name?: string
  /** Permission mode override ('safe' | 'ask' | 'allow-all') */
  mode?: 'safe' | 'ask' | 'allow-all'
  /** Working directory ('user_default' | 'none' | absolute path) */
  workdir?: string
  /** Model override (e.g., 'haiku', 'sonnet') */
  model?: string
  /** Data files to write into the session's data/ folder. Keys are filenames, values are JSON-serializable content. */
  data?: Record<string, unknown>
  /** Message to pre-fill in the chat input (not sent unless autoSend is true) */
  message?: string
  /** When true, message is sent immediately instead of pre-filling the input. Default: false */
  autoSend?: boolean
  /** Status (todo state) to apply */
  status?: string
  /** Label to apply */
  label?: string
}

export interface CreateSessionWithContextResult {
  ok: true
  sessionId: string
}

/**
 * Handle an APP_CREATE_SESSION_WITH_CONTEXT bridge message.
 *
 * Orchestrates: create session → write data files → apply metadata → navigate → send message
 */
export async function handleCreateSessionWithContext(
  payload: CreateSessionWithContextPayload,
  workspaceId: string,
  navigate: (route: Route) => void | Promise<void>,
  onCreateSession: (workspaceId: string, options?: CreateSessionOptions) => Promise<{ id: string }>,
): Promise<CreateSessionWithContextResult> {
  // 1. Build create options
  const createOptions: import('../../shared/types').CreateSessionOptions = {}
  if (payload.mode) {
    createOptions.permissionMode = payload.mode
  }
  if (payload.workdir) {
    createOptions.workingDirectory = payload.workdir
  }
  if (payload.model) {
    createOptions.model = payload.model
  }
  if (payload.status) {
    createOptions.todoState = payload.status
  }
  if (payload.label) {
    createOptions.labels = [payload.label]
  }

  // 2. Create the session (via context callback so it's added to the atom store —
  //    direct IPC would leave it missing from atoms, causing a phantom spinner)
  const session = await onCreateSession(workspaceId, createOptions)

  // 3. Write context data files into session data/ folder
  if (payload.data && Object.keys(payload.data).length > 0) {
    const files: Record<string, string> = {}
    for (const [filename, content] of Object.entries(payload.data)) {
      files[filename] = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    }
    await window.electronAPI.writeSessionData(session.id, files)
  }

  // 4. Rename session if name provided
  if (payload.name) {
    await window.electronAPI.sessionCommand(session.id, { type: 'rename', name: payload.name })
  }

  // 5. Navigate to the new session
  navigate(`allSessions/session/${session.id}` as Route)

  // 6. Pre-fill or auto-send message (delayed to let the session input mount)
  if (payload.message) {
    setTimeout(() => {
      if (payload.autoSend) {
        window.electronAPI.sendMessage(session.id, payload.message!)
      } else {
        window.dispatchEvent(
          new CustomEvent('craft:insert-text', { detail: { text: payload.message } }),
        )
      }
    }, 150)
  }

  return { ok: true, sessionId: session.id }
}
