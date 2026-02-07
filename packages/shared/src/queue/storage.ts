/**
 * Queue Storage
 *
 * Filesystem-based storage for workspace queue configuration, task types, and tasks.
 *
 * Layout:
 *   {workspaceRootPath}/queue/config.json         — queue-level settings
 *   {workspaceRootPath}/queue/types/{slug}/        — task type folders
 *   {workspaceRootPath}/queue/tasks/{task-id}.json — individual task files
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type {
  QueueConfig,
  TaskTypeConfig,
  QueueTask,
  QueueTaskFilter,
  QueueStats,
  TaskStateCategory,
} from './types.ts';
import { debug } from '../utils/debug.ts';

// ============================================================
// Path Constants
// ============================================================

const QUEUE_DIR = 'queue';
const QUEUE_CONFIG_FILE = 'queue/config.json';
const QUEUE_TYPES_DIR = 'queue/types';
const QUEUE_TASKS_DIR = 'queue/tasks';

/**
 * Get path to queue directory
 */
export function getQueueDir(workspaceRootPath: string): string {
  return join(workspaceRootPath, QUEUE_DIR);
}

/**
 * Get path to queue config file
 */
export function getQueueConfigPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, QUEUE_CONFIG_FILE);
}

/**
 * Get path to queue types directory
 */
export function getQueueTypesDir(workspaceRootPath: string): string {
  return join(workspaceRootPath, QUEUE_TYPES_DIR);
}

/**
 * Get path to a specific task type directory
 */
export function getQueueTypePath(workspaceRootPath: string, typeSlug: string): string {
  return join(workspaceRootPath, QUEUE_TYPES_DIR, typeSlug);
}

/**
 * Get path to queue tasks directory
 */
export function getQueueTasksDir(workspaceRootPath: string): string {
  return join(workspaceRootPath, QUEUE_TASKS_DIR);
}

/**
 * Get path to a specific task file
 */
export function getQueueTaskPath(workspaceRootPath: string, taskId: string): string {
  return join(workspaceRootPath, QUEUE_TASKS_DIR, `${taskId}.json`);
}

// ============================================================
// Task ID Generation
// ============================================================

/**
 * Generate a unique task ID: tsk-{YYMMDD}-{random8hex}
 * Date prefix aids chronological sorting. Random hex ensures uniqueness.
 */
export function generateTaskId(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hex = randomBytes(4).toString('hex');
  return `tsk-${yy}${mm}${dd}-${hex}`;
}

/**
 * Generate a URL-safe slug from a name
 */
export function generateTypeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

// ============================================================
// Queue Config Operations
// ============================================================

/**
 * Get default queue configuration
 */
export function getDefaultQueueConfig(): QueueConfig {
  return {
    version: 1,
    enabled: true,
    defaultFilter: 'open',
    autoArchiveDays: 30,
  };
}

/**
 * Load queue configuration from disk.
 * Returns defaults if no config exists or parsing fails.
 */
export function loadQueueConfig(workspaceRootPath: string): QueueConfig {
  const configPath = getQueueConfigPath(workspaceRootPath);

  if (!existsSync(configPath)) {
    return getDefaultQueueConfig();
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as QueueConfig;
    return config;
  } catch (error) {
    console.error('[loadQueueConfig] Failed to parse config:', error);
    return getDefaultQueueConfig();
  }
}

/**
 * Save queue configuration to disk
 */
export function saveQueueConfig(workspaceRootPath: string, config: QueueConfig): void {
  const queueDir = getQueueDir(workspaceRootPath);
  const configPath = getQueueConfigPath(workspaceRootPath);

  if (!existsSync(queueDir)) {
    mkdirSync(queueDir, { recursive: true });
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// ============================================================
// Ensure Directory Structure
// ============================================================

/**
 * Ensure the queue directory structure exists for a workspace.
 * Called during workspace creation and on first queue access.
 */
export function ensureQueueDirs(workspaceRootPath: string): void {
  const dirs = [
    getQueueDir(workspaceRootPath),
    getQueueTypesDir(workspaceRootPath),
    getQueueTasksDir(workspaceRootPath),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// ============================================================
// Task Type Storage
// ============================================================

/**
 * Load a task type configuration by slug.
 * Returns null if not found or invalid.
 */
export function loadTaskType(workspaceRootPath: string, typeSlug: string): TaskTypeConfig | null {
  const configPath = join(getQueueTypePath(workspaceRootPath, typeSlug), 'config.json');

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as TaskTypeConfig;
  } catch (error) {
    debug(`[loadTaskType] Failed to parse type '${typeSlug}':`, error);
    return null;
  }
}

/**
 * Save a task type configuration to disk.
 * Creates the type directory if it doesn't exist.
 */
export function saveTaskType(workspaceRootPath: string, typeConfig: TaskTypeConfig): void {
  const typeDir = getQueueTypePath(workspaceRootPath, typeConfig.slug);
  const configPath = join(typeDir, 'config.json');

  if (!existsSync(typeDir)) {
    mkdirSync(typeDir, { recursive: true });
  }

  writeFileSync(configPath, JSON.stringify(typeConfig, null, 2), 'utf-8');
}

/**
 * Delete a task type directory.
 */
export function deleteTaskTypeDir(workspaceRootPath: string, typeSlug: string): boolean {
  const typeDir = getQueueTypePath(workspaceRootPath, typeSlug);

  if (!existsSync(typeDir)) {
    return false;
  }

  try {
    const { rmSync } = require('fs');
    rmSync(typeDir, { recursive: true });
    return true;
  } catch (error) {
    console.error(`[deleteTaskTypeDir] Failed to delete type '${typeSlug}':`, error);
    return false;
  }
}

/**
 * List all task type slugs in the workspace.
 */
export function listTaskTypeSlugs(workspaceRootPath: string): string[] {
  const typesDir = getQueueTypesDir(workspaceRootPath);

  if (!existsSync(typesDir)) {
    return [];
  }

  try {
    return readdirSync(typesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * List all task types with their full configurations.
 */
export function listTaskTypes(workspaceRootPath: string): TaskTypeConfig[] {
  const slugs = listTaskTypeSlugs(workspaceRootPath);
  const types: TaskTypeConfig[] = [];

  for (const slug of slugs) {
    const config = loadTaskType(workspaceRootPath, slug);
    if (config) {
      types.push(config);
    }
  }

  return types.sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================
// Task Storage
// ============================================================

/**
 * Load a task by ID.
 * Returns null if not found or invalid.
 */
export function loadTask(workspaceRootPath: string, taskId: string): QueueTask | null {
  const taskPath = getQueueTaskPath(workspaceRootPath, taskId);

  if (!existsSync(taskPath)) {
    return null;
  }

  try {
    const raw = readFileSync(taskPath, 'utf-8');
    return JSON.parse(raw) as QueueTask;
  } catch (error) {
    debug(`[loadTask] Failed to parse task '${taskId}':`, error);
    return null;
  }
}

/**
 * Save a task to disk.
 */
export function saveTask(workspaceRootPath: string, task: QueueTask): void {
  const tasksDir = getQueueTasksDir(workspaceRootPath);
  const taskPath = getQueueTaskPath(workspaceRootPath, task.id);

  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }

  writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
}

/**
 * Delete a task file.
 */
export function deleteTaskFile(workspaceRootPath: string, taskId: string): boolean {
  const taskPath = getQueueTaskPath(workspaceRootPath, taskId);

  if (!existsSync(taskPath)) {
    return false;
  }

  try {
    unlinkSync(taskPath);
    return true;
  } catch (error) {
    console.error(`[deleteTaskFile] Failed to delete task '${taskId}':`, error);
    return false;
  }
}

/**
 * List all task IDs in the workspace.
 */
export function listTaskIds(workspaceRootPath: string): string[] {
  const tasksDir = getQueueTasksDir(workspaceRootPath);

  if (!existsSync(tasksDir)) {
    return [];
  }

  try {
    return readdirSync(tasksDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * Find a task by its dedupId within a specific type.
 * Returns the first matching task, or null if none found.
 */
export function findTaskByDedupId(
  workspaceRootPath: string,
  typeSlug: string,
  dedupId: string
): QueueTask | null {
  const taskIds = listTaskIds(workspaceRootPath);

  for (const id of taskIds) {
    const task = loadTask(workspaceRootPath, id);
    if (task && task.typeSlug === typeSlug && task.dedupId === dedupId) {
      return task;
    }
  }

  return null;
}

/**
 * List tasks with optional filtering.
 * Loads all tasks from disk, applies filters, and returns sorted results.
 */
export function listTasks(workspaceRootPath: string, filter?: QueueTaskFilter): QueueTask[] {
  const taskIds = listTaskIds(workspaceRootPath);
  let tasks: QueueTask[] = [];

  // Load all tasks
  for (const id of taskIds) {
    const task = loadTask(workspaceRootPath, id);
    if (task) {
      tasks.push(task);
    }
  }

  // Apply filters
  if (filter) {
    if (filter.typeSlug) {
      tasks = tasks.filter(t => t.typeSlug === filter.typeSlug);
    }

    if (filter.state) {
      tasks = tasks.filter(t => t.state === filter.state);
    }

    if (filter.stateCategory) {
      // Need to look up the state category from the task type
      const typeCache = new Map<string, TaskTypeConfig | null>();
      tasks = tasks.filter(t => {
        if (!typeCache.has(t.typeSlug)) {
          typeCache.set(t.typeSlug, loadTaskType(workspaceRootPath, t.typeSlug));
        }
        const typeConfig = typeCache.get(t.typeSlug);
        if (!typeConfig) return false;
        const stateConfig = typeConfig.states.find(s => s.id === t.state);
        return stateConfig?.category === filter.stateCategory;
      });
    }

    if (filter.labels && filter.labels.length > 0) {
      tasks = tasks.filter(t =>
        filter.labels!.every(label => t.labels.includes(label))
      );
    }

    if (filter.priority !== undefined) {
      tasks = tasks.filter(t => t.priority === filter.priority);
    }

    if (filter.createdAfter) {
      tasks = tasks.filter(t => t.createdAt >= filter.createdAfter!);
    }

    if (filter.createdBefore) {
      tasks = tasks.filter(t => t.createdAt <= filter.createdBefore!);
    }
  }

  // Sort: priority ascending (nulls last), then creation date descending
  tasks.sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return b.createdAt - a.createdAt;
  });

  // Apply pagination
  if (filter?.offset) {
    tasks = tasks.slice(filter.offset);
  }
  if (filter?.limit) {
    tasks = tasks.slice(0, filter.limit);
  }

  return tasks;
}

/**
 * Get summary statistics for the queue.
 */
export function getQueueStats(workspaceRootPath: string): QueueStats {
  const tasks = listTasks(workspaceRootPath);
  const types = listTaskTypes(workspaceRootPath);

  // Build a lookup: typeSlug -> Map<stateId, category>
  const stateCategories = new Map<string, Map<string, TaskStateCategory>>();
  for (const type of types) {
    const stateMap = new Map<string, TaskStateCategory>();
    for (const state of type.states) {
      stateMap.set(state.id, state.category);
    }
    stateCategories.set(type.slug, stateMap);
  }

  const stats: QueueStats = {
    total: tasks.length,
    byCategory: { open: 0, closed: 0 },
    byType: {},
  };

  for (const task of tasks) {
    const stateMap = stateCategories.get(task.typeSlug);
    const category = stateMap?.get(task.state) ?? 'open';

    stats.byCategory[category]++;

    if (!stats.byType[task.typeSlug]) {
      stats.byType[task.typeSlug] = { total: 0, open: 0, closed: 0 };
    }
    const typeStats = stats.byType[task.typeSlug]!;
    typeStats.total++;
    typeStats[category]++;
  }

  return stats;
}
