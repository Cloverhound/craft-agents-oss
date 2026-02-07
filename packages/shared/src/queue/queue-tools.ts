/**
 * Queue Tools
 *
 * Session-scoped MCP tools for the Work Queue system.
 * These tools allow agents to create task types, push tasks,
 * query the queue, and manage task lifecycle.
 *
 * Tools:
 * - queue_push: Create a new task
 * - queue_bulk_push: Create multiple tasks in one call
 * - queue_update: Update task state, data, priority, or labels
 * - queue_get: Get a specific task by ID
 * - queue_list: List/query tasks with filters
 * - queue_stats: Get summary counts by type and state
 * - queue_delete: Delete a task
 * - queue_type_create: Create a new task type
 * - queue_type_list: List available task types
 * - queue_type_get: Get task type definition
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { debug } from '../utils/debug.ts';

import {
  listTaskTypes,
  loadTaskType,
  listTasks,
  loadTask,
  getQueueStats,
} from './storage.ts';

import {
  createTaskType,
  createTask,
  bulkCreateTasks,
  updateTask,
  deleteTask,
} from './crud.ts';

import type { TaskStateCategory, TaskFieldDefinition, TaskStateConfig } from './types.ts';

// ============================================================
// Tool Factories
// ============================================================

/**
 * Create queue_push tool — create a new task
 */
export function createQueuePushTool(sessionId: string, workspaceRootPath: string) {
  return tool(
    'queue_push',
    `Create a new task in the work queue.

Validates the task type exists and required fields are present.
Returns the created task with its generated ID.

If the task type has a dedupTemplate (or dedupId is provided), existing tasks with the same
resolved dedupId are upserted: data/title/priority/labels are updated, state is preserved.`,
    {
      typeSlug: z.string().describe('Task type slug (must exist)'),
      title: z.string().describe('Human-readable task title'),
      data: z.record(z.string(), z.unknown()).describe('Typed data payload matching the type field schema'),
      priority: z.number().optional().describe('Numeric priority (lower = higher). Optional.'),
      labels: z.array(z.string()).optional().describe('Labels (bare IDs or "id::value" format)'),
      state: z.string().optional().describe('Initial state ID. Defaults to the type default state.'),
      dedupId: z.string().optional().describe('Explicit dedup ID for idempotent upserts. Overrides dedupTemplate resolution.'),
    },
    async (args) => {
      debug('[queue_push] Creating task:', args.title);
      try {
        const task = createTask(workspaceRootPath, {
          typeSlug: args.typeSlug,
          title: args.title,
          data: args.data,
          priority: args.priority,
          labels: args.labels,
          state: args.state,
          dedupId: args.dedupId,
          sourceSessionId: sessionId,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, task }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Create queue_bulk_push tool — create multiple tasks in one call
 */
export function createQueueBulkPushTool(sessionId: string, workspaceRootPath: string) {
  return tool(
    'queue_bulk_push',
    `Create multiple tasks in the work queue in a single batch operation.

Each task is validated independently. Returns per-item results (success or error).
Useful for bulk operations like queueing all overdue invoices.

If the task type has a dedupTemplate (or dedupId is provided per task), existing tasks
with matching dedupIds are upserted rather than duplicated.`,
    {
      tasks: z.array(z.object({
        typeSlug: z.string(),
        title: z.string(),
        data: z.record(z.string(), z.unknown()),
        priority: z.number().optional(),
        labels: z.array(z.string()).optional(),
        state: z.string().optional(),
        dedupId: z.string().optional(),
      })).describe('Array of task definitions to create'),
    },
    async (args) => {
      debug(`[queue_bulk_push] Creating ${args.tasks.length} tasks`);

      const inputs = args.tasks.map(t => ({
        ...t,
        sourceSessionId: sessionId,
      }));

      const results = bulkCreateTasks(workspaceRootPath, inputs);

      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            summary: { total: args.tasks.length, succeeded, failed },
            results,
          }, null, 2),
        }],
      };
    }
  );
}

/**
 * Create queue_update tool — update a task
 */
export function createQueueUpdateTool(_sessionId: string, workspaceRootPath: string) {
  return tool(
    'queue_update',
    `Update an existing task in the work queue.

Can change state, title, priority, labels, and data fields.
Data updates are merged (partial update, not full replacement).
Automatically tracks completion time when state moves to a closed category.`,
    {
      taskId: z.string().describe('Task ID to update'),
      title: z.string().optional().describe('New title'),
      state: z.string().optional().describe('New state ID'),
      priority: z.number().optional().describe('New priority'),
      labels: z.array(z.string()).optional().describe('Replace labels array'),
      data: z.record(z.string(), z.unknown()).optional().describe('Data fields to merge'),
    },
    async (args) => {
      debug('[queue_update] Updating task:', args.taskId);
      try {
        const task = updateTask(workspaceRootPath, args.taskId, {
          title: args.title,
          state: args.state,
          priority: args.priority,
          labels: args.labels,
          data: args.data,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, task }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Create queue_get tool — get a specific task
 */
export function createQueueGetTool(_sessionId: string, workspaceRootPath: string) {
  return tool(
    'queue_get',
    `Get a specific task from the work queue by ID.

Returns the full task object including data payload, state, and metadata.`,
    {
      taskId: z.string().describe('Task ID to retrieve'),
    },
    async (args) => {
      const task = loadTask(workspaceRootPath, args.taskId);

      if (!task) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Task '${args.taskId}' not found` }),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(task, null, 2),
        }],
      };
    }
  );
}

/**
 * Create queue_list tool — list/query tasks with filters
 */
export function createQueueListTool(_sessionId: string, workspaceRootPath: string) {
  return tool(
    'queue_list',
    `List tasks from the work queue with optional filters.

Supports filtering by type, state, state category (open/closed), labels, priority, and date range.
Results are sorted by priority (ascending), then creation date (descending).`,
    {
      typeSlug: z.string().optional().describe('Filter by task type slug'),
      state: z.string().optional().describe('Filter by exact state ID'),
      stateCategory: z.enum(['open', 'closed']).optional().describe('Filter by state category'),
      labels: z.array(z.string()).optional().describe('Filter by labels (tasks must have ALL)'),
      priority: z.number().optional().describe('Filter by exact priority'),
      createdAfter: z.number().optional().describe('Filter: created after this timestamp (ms)'),
      createdBefore: z.number().optional().describe('Filter: created before this timestamp (ms)'),
      limit: z.number().optional().describe('Max results (default: all)'),
      offset: z.number().optional().describe('Pagination offset'),
    },
    async (args) => {
      const tasks = listTasks(workspaceRootPath, {
        typeSlug: args.typeSlug,
        state: args.state,
        stateCategory: args.stateCategory as TaskStateCategory | undefined,
        labels: args.labels,
        priority: args.priority,
        createdAfter: args.createdAfter,
        createdBefore: args.createdBefore,
        limit: args.limit,
        offset: args.offset,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ count: tasks.length, tasks }, null, 2),
        }],
      };
    }
  );
}

/**
 * Create queue_stats tool — get summary statistics
 */
export function createQueueStatsTool(_sessionId: string, workspaceRootPath: string) {
  return tool(
    'queue_stats',
    `Get summary statistics for the work queue.

Returns total count, counts by state category (open/closed), and counts by task type.`,
    {},
    async () => {
      const stats = getQueueStats(workspaceRootPath);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(stats, null, 2),
        }],
      };
    }
  );
}

/**
 * Create queue_delete tool — delete a task
 */
export function createQueueDeleteTool(_sessionId: string, workspaceRootPath: string) {
  return tool(
    'queue_delete',
    `Delete a task from the work queue.

Permanently removes the task file. This action cannot be undone.`,
    {
      taskId: z.string().describe('Task ID to delete'),
    },
    async (args) => {
      debug('[queue_delete] Deleting task:', args.taskId);
      try {
        deleteTask(workspaceRootPath, args.taskId);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, taskId: args.taskId }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Create queue_type_create tool — create a new task type
 */
export function createQueueTypeCreateTool(_sessionId: string, workspaceRootPath: string) {
  return tool(
    'queue_type_create',
    `Create a new task type definition for the work queue.

Defines the field schema, lifecycle states, and display behavior for a category of tasks.
Creates the type directory with config.json and a skeleton display.md template.

**Field types:** string, number, date, url, boolean, json
**State categories:** open (active), closed (completed/dismissed)`,
    {
      name: z.string().describe('Display name for the task type'),
      description: z.string().describe('Brief description of what this type represents'),
      icon: z.string().optional().describe('Emoji or URL for the type icon'),
      tagline: z.string().optional().describe('Short tagline for list display'),
      source: z.string().optional().describe('Source integration slug (e.g., "xero", "znuny")'),
      dedupTemplate: z.string().optional().describe('Dedup template with {field} placeholders for idempotent upserts (e.g., "xero:{invoice_number}")'),
      fields: z.record(z.string(), z.object({
        type: z.enum(['string', 'number', 'date', 'url', 'boolean', 'json']),
        label: z.string(),
        required: z.boolean().optional(),
      })).describe('Field schema defining the typed data payload'),
      states: z.array(z.object({
        id: z.string(),
        label: z.string(),
        category: z.enum(['open', 'closed']),
        color: z.union([
          z.string(),
          z.object({ light: z.string(), dark: z.string().optional() }),
        ]).optional(),
        isDefault: z.boolean().optional(),
      })).describe('Lifecycle states for this task type'),
      displayTemplate: z.string().optional().describe('Content for display.md template'),
    },
    async (args) => {
      debug('[queue_type_create] Creating type:', args.name);
      try {
        const typeConfig = createTaskType(workspaceRootPath, {
          name: args.name,
          description: args.description,
          icon: args.icon,
          tagline: args.tagline,
          source: args.source,
          dedupTemplate: args.dedupTemplate,
          fields: args.fields as Record<string, TaskFieldDefinition>,
          states: args.states as TaskStateConfig[],
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, type: typeConfig }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Create queue_type_list tool — list available task types
 */
export function createQueueTypeListTool(_sessionId: string, workspaceRootPath: string) {
  return tool(
    'queue_type_list',
    `List all available task types in the work queue.

Returns type configurations including field schemas, states, and metadata.`,
    {},
    async () => {
      const types = listTaskTypes(workspaceRootPath);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ count: types.length, types }, null, 2),
        }],
      };
    }
  );
}

/**
 * Create queue_type_get tool — get a specific task type
 */
export function createQueueTypeGetTool(_sessionId: string, workspaceRootPath: string) {
  return tool(
    'queue_type_get',
    `Get a specific task type definition by slug.

Returns the full type configuration including field schema, states, and metadata.`,
    {
      typeSlug: z.string().describe('Task type slug to retrieve'),
    },
    async (args) => {
      const typeConfig = loadTaskType(workspaceRootPath, args.typeSlug);

      if (!typeConfig) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Task type '${args.typeSlug}' not found` }),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(typeConfig, null, 2),
        }],
      };
    }
  );
}
