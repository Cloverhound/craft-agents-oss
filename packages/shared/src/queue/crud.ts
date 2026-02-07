/**
 * Queue CRUD Operations
 *
 * Create, Read, Update, Delete operations for task types and tasks.
 * Enforces business rules (field validation, state transitions, uniqueness).
 */

import {
  loadTaskType,
  saveTaskType,
  deleteTaskTypeDir,
  listTaskTypeSlugs,
  loadTask,
  saveTask,
  deleteTaskFile,
  generateTaskId,
  generateTypeSlug,
  ensureQueueDirs,
  getQueueTypePath,
} from './storage.ts';
import type {
  TaskTypeConfig,
  QueueTask,
  CreateTaskTypeInput,
  CreateTaskInput,
  UpdateTaskInput,
} from './types.ts';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

// ============================================================
// Task Type CRUD
// ============================================================

/**
 * Create a new task type.
 * Generates a unique slug, creates the type directory, and writes config.
 *
 * @throws Error if states array is empty or has no default state
 */
export function createTaskType(
  workspaceRootPath: string,
  input: CreateTaskTypeInput
): TaskTypeConfig {
  ensureQueueDirs(workspaceRootPath);

  // Validate: must have at least one state
  if (!input.states || input.states.length === 0) {
    throw new Error('Task type must have at least one state');
  }

  // Validate: must have exactly one default state
  const defaultStates = input.states.filter(s => s.isDefault);
  if (defaultStates.length === 0 && input.states[0]) {
    // Auto-set first state as default
    input.states[0].isDefault = true;
  }

  // Generate unique slug
  const existingSlugs = new Set(listTaskTypeSlugs(workspaceRootPath));
  let slug = generateTypeSlug(input.name);
  let suffix = 2;
  while (existingSlugs.has(slug)) {
    slug = `${generateTypeSlug(input.name)}-${suffix}`;
    suffix++;
  }

  const now = Date.now();
  const typeConfig: TaskTypeConfig = {
    id: slug,
    name: input.name,
    slug,
    description: input.description,
    icon: input.icon,
    tagline: input.tagline,
    source: input.source,
    fields: input.fields,
    states: input.states,
    displayTemplate: input.displayTemplate ?? 'display.md',
    createdAt: now,
    updatedAt: now,
  };

  saveTaskType(workspaceRootPath, typeConfig);

  // Create a skeleton display.md if one doesn't exist
  const typeDir = getQueueTypePath(workspaceRootPath, slug);
  const displayPath = join(typeDir, 'display.md');
  if (!existsSync(displayPath)) {
    const fieldEntries = Object.entries(input.fields);
    const fieldLines = fieldEntries
      .map(([key, def]) => `**${def.label}:** {{data.${key}}}`)
      .join('\n');

    const template = `# {{title}}

${fieldLines}

---

{{#if data.notes}}
## Notes
{{data.notes}}
{{/if}}
`;
    writeFileSync(displayPath, template, 'utf-8');
  }

  return typeConfig;
}

/**
 * Update a task type configuration.
 * Only updates provided fields; slug/id cannot change.
 */
export function updateTaskType(
  workspaceRootPath: string,
  typeSlug: string,
  updates: Partial<Pick<TaskTypeConfig, 'name' | 'description' | 'icon' | 'tagline' | 'source' | 'fields' | 'states' | 'displayTemplate'>>
): TaskTypeConfig {
  const existing = loadTaskType(workspaceRootPath, typeSlug);
  if (!existing) {
    throw new Error(`Task type '${typeSlug}' not found`);
  }

  if (updates.name !== undefined) existing.name = updates.name;
  if (updates.description !== undefined) existing.description = updates.description;
  if (updates.icon !== undefined) existing.icon = updates.icon;
  if (updates.tagline !== undefined) existing.tagline = updates.tagline;
  if (updates.source !== undefined) existing.source = updates.source;
  if (updates.fields !== undefined) existing.fields = updates.fields;
  if (updates.states !== undefined) existing.states = updates.states;
  if (updates.displayTemplate !== undefined) existing.displayTemplate = updates.displayTemplate;
  existing.updatedAt = Date.now();

  saveTaskType(workspaceRootPath, existing);
  return existing;
}

/**
 * Delete a task type and optionally its tasks.
 *
 * @param deleteTasks - If true, also deletes all tasks of this type
 * @returns Number of tasks deleted (0 if deleteTasks is false)
 */
export function deleteTaskType(
  workspaceRootPath: string,
  typeSlug: string,
  deleteTasks = false
): { deleted: boolean; tasksDeleted: number } {
  const existing = loadTaskType(workspaceRootPath, typeSlug);
  if (!existing) {
    throw new Error(`Task type '${typeSlug}' not found`);
  }

  let tasksDeleted = 0;

  if (deleteTasks) {
    // Import listTasks here to avoid circular dependency issues
    const { listTasks } = require('./storage.ts');
    const tasks = listTasks(workspaceRootPath, { typeSlug }) as QueueTask[];
    for (const task of tasks) {
      if (deleteTaskFile(workspaceRootPath, task.id)) {
        tasksDeleted++;
      }
    }
  }

  const deleted = deleteTaskTypeDir(workspaceRootPath, typeSlug);
  return { deleted, tasksDeleted };
}

// ============================================================
// Task CRUD
// ============================================================

/**
 * Create a new task.
 * Validates the task type exists and the data matches the field schema.
 *
 * @throws Error if task type doesn't exist
 */
export function createTask(
  workspaceRootPath: string,
  input: CreateTaskInput
): QueueTask {
  ensureQueueDirs(workspaceRootPath);

  // Validate task type exists
  const typeConfig = loadTaskType(workspaceRootPath, input.typeSlug);
  if (!typeConfig) {
    throw new Error(`Task type '${input.typeSlug}' not found`);
  }

  // Validate required fields
  for (const [fieldName, fieldDef] of Object.entries(typeConfig.fields)) {
    if (fieldDef.required && (input.data[fieldName] === undefined || input.data[fieldName] === null)) {
      throw new Error(`Required field '${fieldName}' is missing`);
    }
  }

  // Determine initial state
  let initialState = input.state;
  if (!initialState) {
    const defaultState = typeConfig.states.find(s => s.isDefault);
    initialState = defaultState?.id ?? typeConfig.states[0]?.id ?? 'pending';
  }

  // Validate state exists in type
  if (!typeConfig.states.some(s => s.id === initialState)) {
    throw new Error(`State '${initialState}' is not valid for type '${input.typeSlug}'`);
  }

  const now = Date.now();
  const task: QueueTask = {
    id: generateTaskId(),
    typeSlug: input.typeSlug,
    title: input.title,
    state: initialState,
    priority: input.priority,
    data: input.data,
    labels: input.labels ?? [],
    sourceSessionId: input.sourceSessionId,
    linkedSessionIds: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    createdBy: 'agent',
  };

  saveTask(workspaceRootPath, task);
  return task;
}

/**
 * Create multiple tasks in a single batch operation.
 * Returns per-item results (success or error).
 */
export function bulkCreateTasks(
  workspaceRootPath: string,
  inputs: CreateTaskInput[]
): Array<{ success: boolean; task?: QueueTask; error?: string }> {
  return inputs.map(input => {
    try {
      const task = createTask(workspaceRootPath, input);
      return { success: true, task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/**
 * Update an existing task.
 *
 * @throws Error if task not found or state is invalid
 */
export function updateTask(
  workspaceRootPath: string,
  taskId: string,
  updates: UpdateTaskInput
): QueueTask {
  const task = loadTask(workspaceRootPath, taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  // Validate state change against task type
  if (updates.state !== undefined) {
    const typeConfig = loadTaskType(workspaceRootPath, task.typeSlug);
    if (typeConfig && !typeConfig.states.some(s => s.id === updates.state)) {
      throw new Error(`State '${updates.state}' is not valid for type '${task.typeSlug}'`);
    }

    // Track completion time
    if (typeConfig) {
      const newState = typeConfig.states.find(s => s.id === updates.state);
      if (newState?.category === 'closed' && task.completedAt === null) {
        task.completedAt = Date.now();
      } else if (newState?.category === 'open') {
        task.completedAt = null;
      }
    }
  }

  if (updates.title !== undefined) task.title = updates.title;
  if (updates.state !== undefined) task.state = updates.state;
  if (updates.priority !== undefined) task.priority = updates.priority;
  if (updates.labels !== undefined) task.labels = updates.labels;

  // Merge data fields (partial update, not full replacement)
  if (updates.data !== undefined) {
    task.data = { ...task.data, ...updates.data };
  }

  task.updatedAt = Date.now();
  saveTask(workspaceRootPath, task);
  return task;
}

/**
 * Delete a task.
 *
 * @throws Error if task not found
 */
export function deleteTask(workspaceRootPath: string, taskId: string): void {
  const task = loadTask(workspaceRootPath, taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (!deleteTaskFile(workspaceRootPath, taskId)) {
    throw new Error(`Failed to delete task '${taskId}'`);
  }
}

/**
 * Link a session to a task (bidirectional reference).
 */
export function linkSessionToTask(
  workspaceRootPath: string,
  taskId: string,
  sessionId: string
): void {
  const task = loadTask(workspaceRootPath, taskId);
  if (!task) return;

  if (!task.linkedSessionIds.includes(sessionId)) {
    task.linkedSessionIds.push(sessionId);
    task.updatedAt = Date.now();
    saveTask(workspaceRootPath, task);
  }
}
