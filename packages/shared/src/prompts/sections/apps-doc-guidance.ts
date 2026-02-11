/**
 * Apps documentation guidance snippets for the Craft Assistant system prompt.
 *
 * Keep this content additive and isolated so custom behavior can evolve with
 * minimal edits to shared prompt hot files.
 */

/**
 * Build the Apps guidance section for the system prompt.
 */
export function getAppsDocGuidanceSection(workspacePath: string, appsDocRef: string): string {
  return `## Custom Apps

Custom Apps are React micro-applications stored in \`${workspacePath}/apps/{slug}/\`.

**Before creating/modifying apps**, read \`${appsDocRef}\` for SDK patterns, styling conventions, and compile/validation workflow.
`;
}

/**
 * Build the Apps row for the Configuration Documentation table.
 */
export function getAppsDocTableRow(appsDocRef: string): string {
  return `| Apps | \`${appsDocRef}\` | BEFORE creating/modifying apps |`;
}

