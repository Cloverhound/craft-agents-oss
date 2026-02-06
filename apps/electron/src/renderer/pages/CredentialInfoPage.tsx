/**
 * CredentialInfoPage
 *
 * Displays comprehensive credential details including metadata,
 * authentication status, URL patterns, and config location.
 * Uses the Info_ component system for consistent styling with SkillInfoPage/SourceInfoPage.
 */

import * as React from 'react'
import { useEffect, useState, useCallback } from 'react'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { toast } from 'sonner'
import { CredentialMenu } from '@/components/app-shell/CredentialMenu'
import { CredentialAvatar } from '@/components/ui/credential-avatar'
import { routes, navigate } from '@/lib/navigate'
import {
  Info_Page,
  Info_Section,
  Info_Table,
  Info_Badge,
} from '@/components/info'
import type { LoadedCredentialConfig } from '../../shared/types'

interface CredentialInfoPageProps {
  credentialSlug: string
  workspaceId: string
}

/** Human-readable label for auth type */
function authTypeLabel(type: string): string {
  switch (type) {
    case 'bearer': return 'Bearer Token'
    case 'header': return 'Custom Header'
    case 'multi-header': return 'Multi-Header'
    case 'query': return 'Query Parameter'
    case 'basic': return 'Basic Auth'
    case 'oauth2': return 'OAuth 2.0 + PKCE'
    default: return type
  }
}

export default function CredentialInfoPage({ credentialSlug, workspaceId }: CredentialInfoPageProps) {
  const [credential, setCredential] = useState<LoadedCredentialConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load credential data
  useEffect(() => {
    let isMounted = true
    setLoading(true)
    setError(null)

    const loadCredential = async () => {
      try {
        const credentials = await window.electronAPI.getCredentials(workspaceId)

        if (!isMounted) return

        // Find the credential by slug
        const found = credentials.find((c) => c.slug === credentialSlug)
        if (found) {
          setCredential(found)
        } else {
          setError('Credential not found')
        }
      } catch (err) {
        if (!isMounted) return
        setError(err instanceof Error ? err.message : 'Failed to load credential')
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    loadCredential()

    // Subscribe to credential changes
    const unsubscribe = window.electronAPI.onCredentialsChanged?.((credentials) => {
      const updated = credentials.find((c) => c.slug === credentialSlug)
      if (updated) {
        setCredential(updated)
      }
    })

    return () => {
      isMounted = false
      unsubscribe?.()
    }
  }, [workspaceId, credentialSlug])

  // Handle show in finder
  const handleShowInFinder = useCallback(async () => {
    if (!credential) return

    try {
      await window.electronAPI.openCredentialInFinder(workspaceId, credentialSlug)
    } catch (err) {
      console.error('Failed to open credential in finder:', err)
    }
  }, [credential, workspaceId, credentialSlug])

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!credential) return

    try {
      await window.electronAPI.deleteCredential(workspaceId, credentialSlug)
      toast.success(`Deleted credential: ${credential.name}`)
      navigate(routes.view.credentials())
    } catch (err) {
      toast.error('Failed to delete credential', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }, [credential, workspaceId, credentialSlug])

  // Handle opening in new window
  const handleOpenInNewWindow = useCallback(() => {
    window.electronAPI.openUrl(`craftagents://credentials/credential/${credentialSlug}?window=focused`)
  }, [credentialSlug])

  // Get credential name for header
  const credentialName = credential?.name || credentialSlug

  // Format config path to show workspace-relative portion
  const formatPath = (path: string) => {
    const credsIndex = path.indexOf('/credentials/')
    if (credsIndex !== -1) {
      return path.slice(credsIndex + 1)
    }
    return path
  }

  // Open the credential config file in Finder
  const handleLocationClick = () => {
    if (!credential) return
    window.electronAPI.showInFolder(credential.configPath)
  }

  return (
    <Info_Page
      loading={loading}
      error={error ?? undefined}
      empty={!credential && !loading && !error ? 'Credential not found' : undefined}
    >
      <Info_Page.Header
        title={credentialName}
        titleMenu={
          <CredentialMenu
            credentialSlug={credentialSlug}
            credentialName={credentialName}
            onOpenInNewWindow={handleOpenInNewWindow}
            onShowInFinder={handleShowInFinder}
            onDelete={handleDelete}
          />
        }
      />

      {credential && (
        <Info_Page.Content>
          {/* Hero: Avatar, title, and description */}
          <Info_Page.Hero
            avatar={<CredentialAvatar credential={credential} fluid workspaceId={workspaceId} />}
            title={credential.name}
            tagline={credential.description || `${authTypeLabel(credential.auth.type)} authentication`}
          />

          {/* Metadata */}
          <Info_Section
            title="Metadata"
            actions={
              <EditPopover
                trigger={<EditButton />}
                {...getEditConfig('credential-config', credential.configPath)}
                secondaryAction={{
                  label: 'Edit File',
                  filePath: credential.configPath,
                }}
              />
            }
          >
            <Info_Table>
              <Info_Table.Row label="Slug" value={credential.slug} />
              <Info_Table.Row label="Name">{credential.name}</Info_Table.Row>
              {credential.description && (
                <Info_Table.Row label="Description">
                  {credential.description}
                </Info_Table.Row>
              )}
              <Info_Table.Row label="Auth Type">
                <Info_Badge color="default">{authTypeLabel(credential.auth.type)}</Info_Badge>
              </Info_Table.Row>
              <Info_Table.Row label="Status">
                <Info_Badge color={credential.isAuthenticated ? 'success' : 'warning'}>
                  {credential.isAuthenticated ? 'Authenticated' : 'Not authenticated'}
                </Info_Badge>
              </Info_Table.Row>
              <Info_Table.Row label="Location">
                <button
                  onClick={handleLocationClick}
                  className="hover:underline cursor-pointer text-left"
                >
                  {formatPath(credential.configPath)}
                </button>
              </Info_Table.Row>
            </Info_Table>
          </Info_Section>

          {/* URL Patterns */}
          <Info_Section title="URL Patterns">
            <div className="px-4 py-3 space-y-1.5">
              <p className="text-xs text-muted-foreground mb-2">
                Requests matching these patterns will have credentials automatically injected:
              </p>
              {credential.urlPatterns.map((pattern, i) => (
                <div
                  key={i}
                  className="font-mono text-sm px-2.5 py-1.5 rounded-[6px] bg-foreground/[0.03] border border-border/30"
                >
                  {pattern}
                </div>
              ))}
            </div>
          </Info_Section>

          {/* Auth Details */}
          <Info_Section title="Authentication Details">
            <Info_Table>
              <Info_Table.Row label="Type">{authTypeLabel(credential.auth.type)}</Info_Table.Row>
              {credential.auth.type === 'bearer' && credential.auth.scheme && (
                <Info_Table.Row label="Scheme">{credential.auth.scheme}</Info_Table.Row>
              )}
              {credential.auth.type === 'header' && (
                <Info_Table.Row label="Header Name">{credential.auth.headerName}</Info_Table.Row>
              )}
              {credential.auth.type === 'multi-header' && (
                <Info_Table.Row label="Header Names">
                  {credential.auth.headerNames.join(', ')}
                </Info_Table.Row>
              )}
              {credential.auth.type === 'query' && (
                <Info_Table.Row label="Parameter Name">{credential.auth.paramName}</Info_Table.Row>
              )}
              {credential.auth.type === 'oauth2' && (
                <>
                  <Info_Table.Row label="Authorize URL">
                    <span className="font-mono text-xs break-all">{credential.auth.authorizeUrl}</span>
                  </Info_Table.Row>
                  <Info_Table.Row label="Token URL">
                    <span className="font-mono text-xs break-all">{credential.auth.tokenUrl}</span>
                  </Info_Table.Row>
                  <Info_Table.Row label="Scopes">
                    {credential.auth.scopes.join(', ')}
                  </Info_Table.Row>
                </>
              )}
              {credential.lastTestedAt && (
                <Info_Table.Row label="Last Tested">
                  {new Date(credential.lastTestedAt).toLocaleString()}
                </Info_Table.Row>
              )}
            </Info_Table>
          </Info_Section>

          {/* Explore Mode Permissions */}
          {credential.permissions?.explore && (
            <Info_Section title="Explore Mode Permissions">
              <Info_Table>
                <Info_Table.Row label="Allowed Methods">
                  <div className="flex gap-1.5 flex-wrap">
                    {credential.permissions.explore.methods.map((method) => (
                      <Info_Badge key={method} color="default">{method}</Info_Badge>
                    ))}
                  </div>
                </Info_Table.Row>
                {credential.permissions.explore.comment && (
                  <Info_Table.Row label="Comment">
                    {credential.permissions.explore.comment}
                  </Info_Table.Row>
                )}
              </Info_Table>
            </Info_Section>
          )}

          {/* Test Request */}
          {credential.testRequest && (
            <Info_Section title="Test Request">
              <Info_Table>
                <Info_Table.Row label="URL">
                  <span className="font-mono text-xs break-all">{credential.testRequest.url}</span>
                </Info_Table.Row>
                {credential.testRequest.method && (
                  <Info_Table.Row label="Method">
                    <Info_Badge color="default">{credential.testRequest.method}</Info_Badge>
                  </Info_Table.Row>
                )}
              </Info_Table>
            </Info_Section>
          )}

        </Info_Page.Content>
      )}
    </Info_Page>
  )
}
