import type { LoadedSkill } from '../../skills/types.ts';
import { loadWorkspaceSkills } from '../../skills/storage.ts';

/**
 * Build explicit skill usage instructions for Codex developerInstructions.
 * Mirrors AGENTS.md-style guidance so Codex consistently follows skill workflows.
 */
export function buildCodexSkillDeveloperInstructions(skills: LoadedSkill[]): string {
  const availableSkillsSection = skills.length > 0
    ? skills
        .map(skill => {
          const description = skill.metadata.description || 'No description provided.';
          return `- ${skill.slug}: ${description} (file: ${skill.path}/SKILL.md)`;
        })
        .join('\n')
    : '- (none discovered in workspace skills directory)';

  return `## Skills
A skill is a set of local instructions stored in a SKILL.md file.

### Available skills
${availableSkillsSection}

### How to use skills
- Discovery: Use the list above as the available skills for this session.
- Trigger rules: If the user names a skill (e.g. $SkillName, [skill:slug], or plain text) OR the task clearly matches a skill description, use that skill for this turn. If multiple skills apply, use the minimal set.
- Missing/blocked: If a named skill is unavailable or unreadable, say so briefly and continue with best fallback.
- Workflow: Open SKILL.md first, read only what you need, resolve relative paths from the skill directory, and prefer any provided scripts/templates/assets over rewriting from scratch.
- Coordination: Announce which skill(s) you are using and why in one short line. If you skip an obvious skill, say why.
- Context hygiene: Load only the files needed for the current request; avoid bulk-loading references.
- Safety fallback: If instructions are unclear or incomplete, state the issue and continue with the best safe approach.`;
}

/**
 * Build Codex developer instructions for a workspace by discovering available skills.
 */
export function getCodexDeveloperInstructions(workspaceRoot: string): string {
  const skills = loadWorkspaceSkills(workspaceRoot);
  return buildCodexSkillDeveloperInstructions(skills);
}
