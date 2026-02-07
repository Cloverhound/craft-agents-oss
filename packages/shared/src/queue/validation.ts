/**
 * Queue Validation
 *
 * Runtime validation for queue configurations, task types, and tasks.
 * Ensures data integrity and catches config issues early.
 */

import { loadQueueConfig, loadTaskType, listTaskTypeSlugs, listTaskIds, loadTask, getQueueTypePath } from './storage.ts';
import type { QueueConfig, TaskTypeConfig, QueueTask } from './types.ts';
import { existsSync } from 'fs';
import { join } from 'path';

// ============================================================
// Validation Result
// ============================================================

export interface QueueValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================================
// Slug Validation
// ============================================================

const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Check if a string is a valid slug (lowercase alphanumeric with hyphens)
 */
export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug) && slug.length > 0 && slug.length <= 50;
}

// ============================================================
// Queue Config Validation
// ============================================================

/**
 * Validate the top-level queue config.
 */
export function validateQueueConfig(config: QueueConfig): QueueValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (config.version !== 1) {
    errors.push(`Unsupported version: ${config.version} (expected 1)`);
  }

  if (typeof config.enabled !== 'boolean') {
    errors.push(`'enabled' must be a boolean`);
  }

  if (typeof config.autoArchiveDays !== 'number' || config.autoArchiveDays < 0) {
    warnings.push(`'autoArchiveDays' should be a non-negative number`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================
// Task Type Validation
// ============================================================

/**
 * Validate a task type configuration.
 */
export function validateTaskType(typeConfig: TaskTypeConfig): QueueValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ID / slug
  if (!typeConfig.id || !isValidSlug(typeConfig.id)) {
    errors.push(`Invalid type ID: '${typeConfig.id}' (must be lowercase alphanumeric with hyphens)`);
  }

  if (typeConfig.id !== typeConfig.slug) {
    errors.push(`Type ID '${typeConfig.id}' must match slug '${typeConfig.slug}'`);
  }

  // Name
  if (!typeConfig.name || typeConfig.name.trim().length === 0) {
    errors.push(`Type name is required`);
  }

  // Description
  if (!typeConfig.description || typeConfig.description.trim().length === 0) {
    warnings.push(`Type '${typeConfig.id}' has no description`);
  }

  // States
  if (!typeConfig.states || typeConfig.states.length === 0) {
    errors.push(`Type '${typeConfig.id}' must have at least one state`);
  } else {
    // Check for duplicate state IDs
    const stateIds = new Set<string>();
    for (const state of typeConfig.states) {
      if (stateIds.has(state.id)) {
        errors.push(`Duplicate state ID '${state.id}' in type '${typeConfig.id}'`);
      }
      stateIds.add(state.id);

      if (!state.id || !isValidSlug(state.id)) {
        errors.push(`Invalid state ID: '${state.id}'`);
      }
      if (!state.label) {
        errors.push(`State '${state.id}' must have a label`);
      }
      if (state.category !== 'open' && state.category !== 'closed') {
        errors.push(`State '${state.id}' must have category 'open' or 'closed'`);
      }
    }

    // Must have at least one open and one closed state
    const hasOpen = typeConfig.states.some(s => s.category === 'open');
    const hasClosed = typeConfig.states.some(s => s.category === 'closed');
    if (!hasOpen) {
      warnings.push(`Type '${typeConfig.id}' has no open states`);
    }
    if (!hasClosed) {
      warnings.push(`Type '${typeConfig.id}' has no closed states`);
    }

    // Must have a default state
    const defaults = typeConfig.states.filter(s => s.isDefault);
    if (defaults.length === 0) {
      warnings.push(`Type '${typeConfig.id}' has no default state (first state will be used)`);
    }
    if (defaults.length > 1) {
      warnings.push(`Type '${typeConfig.id}' has multiple default states`);
    }
  }

  // Dedup template
  if (typeConfig.dedupTemplate) {
    const placeholders = typeConfig.dedupTemplate.match(/\{([^}]+)\}/g);
    if (placeholders) {
      for (const placeholder of placeholders) {
        const fieldName = placeholder.slice(1, -1);
        if (!typeConfig.fields[fieldName]) {
          errors.push(`dedupTemplate references unknown field '${fieldName}'`);
        }
      }
    } else {
      warnings.push(`dedupTemplate has no {field} placeholders — it will produce the same dedupId for every task`);
    }
  }

  // Fields
  if (typeConfig.fields) {
    const validFieldTypes = ['string', 'number', 'date', 'url', 'boolean', 'json'];
    for (const [fieldName, fieldDef] of Object.entries(typeConfig.fields)) {
      if (!validFieldTypes.includes(fieldDef.type)) {
        errors.push(`Field '${fieldName}' has invalid type '${fieldDef.type}'`);
      }
      if (!fieldDef.label) {
        warnings.push(`Field '${fieldName}' has no label`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================
// Task Validation
// ============================================================

/**
 * Validate a task against its type definition.
 */
export function validateTask(
  task: QueueTask,
  typeConfig: TaskTypeConfig | null
): QueueValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!task.id) {
    errors.push('Task must have an ID');
  }

  if (!task.typeSlug) {
    errors.push('Task must have a typeSlug');
  }

  if (!task.title) {
    warnings.push(`Task '${task.id}' has no title`);
  }

  if (!typeConfig) {
    warnings.push(`Task '${task.id}' references unknown type '${task.typeSlug}'`);
    return { valid: errors.length === 0, errors, warnings };
  }

  // Validate state
  if (!typeConfig.states.some(s => s.id === task.state)) {
    errors.push(`Task '${task.id}' has invalid state '${task.state}' for type '${task.typeSlug}'`);
  }

  // Validate required fields
  for (const [fieldName, fieldDef] of Object.entries(typeConfig.fields)) {
    if (fieldDef.required && (task.data[fieldName] === undefined || task.data[fieldName] === null)) {
      warnings.push(`Task '${task.id}' is missing required field '${fieldName}'`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================
// Full Workspace Queue Validation
// ============================================================

/**
 * Validate the entire queue system for a workspace.
 * Checks config, all types, and all tasks.
 */
export function validateQueue(workspaceRootPath: string): QueueValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Validate queue config
  const config = loadQueueConfig(workspaceRootPath);
  const configResult = validateQueueConfig(config);
  errors.push(...configResult.errors);
  warnings.push(...configResult.warnings);

  // 2. Validate all task types
  const typeSlugs = listTaskTypeSlugs(workspaceRootPath);
  const typeMap = new Map<string, TaskTypeConfig>();

  for (const slug of typeSlugs) {
    const typeConfig = loadTaskType(workspaceRootPath, slug);
    if (!typeConfig) {
      errors.push(`Failed to load task type '${slug}'`);
      continue;
    }

    typeMap.set(slug, typeConfig);

    const typeResult = validateTaskType(typeConfig);
    errors.push(...typeResult.errors.map(e => `[type:${slug}] ${e}`));
    warnings.push(...typeResult.warnings.map(w => `[type:${slug}] ${w}`));

    // Check icon file
    const typeDir = getQueueTypePath(workspaceRootPath, slug);
    if (typeConfig.icon && !typeConfig.icon.startsWith('http') && !existsSync(join(typeDir, typeConfig.icon))) {
      warnings.push(`[type:${slug}] Icon file not found`);
    }
  }

  // 3. Validate all tasks
  const taskIds = listTaskIds(workspaceRootPath);
  const referencedTypes = new Set<string>();

  for (const taskId of taskIds) {
    const task = loadTask(workspaceRootPath, taskId);
    if (!task) {
      errors.push(`Failed to load task '${taskId}'`);
      continue;
    }

    referencedTypes.add(task.typeSlug);
    const typeConfig = typeMap.get(task.typeSlug) ?? null;
    const taskResult = validateTask(task, typeConfig);
    errors.push(...taskResult.errors.map(e => `[task:${taskId}] ${e}`));
    warnings.push(...taskResult.warnings.map(w => `[task:${taskId}] ${w}`));
  }

  // 4. Check for orphaned tasks (referencing deleted types)
  for (const typeSlug of referencedTypes) {
    if (!typeMap.has(typeSlug)) {
      warnings.push(`Orphaned tasks reference deleted type '${typeSlug}'`);
    }
  }

  // 5. Check for duplicate dedupIds within the same type
  const dedupIndex = new Map<string, string[]>(); // "typeSlug:dedupId" → [taskIds]
  for (const taskId of taskIds) {
    const task = loadTask(workspaceRootPath, taskId);
    if (task?.dedupId) {
      const key = `${task.typeSlug}:${task.dedupId}`;
      if (!dedupIndex.has(key)) dedupIndex.set(key, []);
      dedupIndex.get(key)!.push(task.id);
    }
  }
  for (const [key, ids] of dedupIndex) {
    if (ids.length > 1) {
      warnings.push(`Duplicate dedupId '${key}' shared by tasks: ${ids.join(', ')}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
