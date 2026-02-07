/**
 * Queue Types
 *
 * Types for the Work Queue system.
 * The queue provides a task management layer that agents can populate
 * via skill/credential integrations (e.g., Xero invoices, Znuny tickets).
 *
 * Storage:
 * - Queue config: {workspaceRootPath}/queue/config.json
 * - Task types: {workspaceRootPath}/queue/types/{slug}/config.json
 * - Tasks: {workspaceRootPath}/queue/tasks/{task-id}.json
 *
 * Color format: EntityColor (system color string or custom color object)
 * - System: "accent", "foreground/50", "info/80" (uses CSS variables, auto light/dark)
 * - Custom: { light: "#EF4444", dark: "#F87171" } (explicit values)
 */

import type { EntityColor } from '../colors/types.ts'

// ============================================================
// Queue Config
// ============================================================

/**
 * Top-level queue configuration for a workspace.
 * Stored at {workspaceRootPath}/queue/config.json
 */
export interface QueueConfig {
  /** Schema version for migrations (start at 1) */
  version: number;

  /** Whether the queue system is enabled */
  enabled: boolean;

  /** Default state filter when viewing the queue ('pending' or 'open') */
  defaultFilter: string;

  /** Auto-archive completed tasks after this many days (0 = never) */
  autoArchiveDays: number;
}

// ============================================================
// Task Type
// ============================================================

/** Supported field types for task type schema */
export type TaskFieldType = 'string' | 'number' | 'date' | 'url' | 'boolean' | 'json';

/**
 * Definition of a single field in a task type schema.
 */
export interface TaskFieldDefinition {
  /** Field data type */
  type: TaskFieldType;

  /** Display label for UI rendering */
  label: string;

  /** Whether this field is required when creating a task */
  required?: boolean;
}

/**
 * Task state category — mirrors the session status pattern.
 * - 'open': Task is active/actionable
 * - 'closed': Task is completed/dismissed
 */
export type TaskStateCategory = 'open' | 'closed';

/**
 * A lifecycle state for a task type.
 * Each type defines its own state machine.
 */
export interface TaskStateConfig {
  /** Unique ID (slug-style: 'pending', 'in-progress', 'done') */
  id: string;

  /** Display label */
  label: string;

  /** Category (open = active, closed = archived) */
  category: TaskStateCategory;

  /** Optional color for state badge */
  color?: EntityColor;

  /** Whether this is the default state for new tasks */
  isDefault?: boolean;
}

/**
 * Task type configuration.
 * Stored at {workspaceRootPath}/queue/types/{slug}/config.json
 *
 * Each task type defines a schema of fields, lifecycle states,
 * and display behavior for its tasks.
 */
export interface TaskTypeConfig {
  /** Unique ID (matches folder slug) */
  id: string;

  /** Display name */
  name: string;

  /** URL-safe slug (lowercase, hyphens) */
  slug: string;

  /** Brief description */
  description: string;

  /** Icon: emoji or URL (auto-downloaded to types/{slug}/icon.{ext}) */
  icon?: string;

  /** Short tagline for list display */
  tagline?: string;

  /** Optional link to originating source integration slug */
  source?: string;

  /**
   * Dedup template — a pattern string with {field} placeholders that resolves
   * to a deterministic dedup ID from task data. Makes push operations idempotent.
   * Example: "xero:{invoice_number}" → "xero:INV-2828"
   */
  dedupTemplate?: string;

  /** Field schema — defines the typed data payload for tasks of this type */
  fields: Record<string, TaskFieldDefinition>;

  /** Lifecycle states for this task type */
  states: TaskStateConfig[];

  /** Reference to display template file (relative, e.g., 'display.md') */
  displayTemplate?: string;

  /** Timestamps */
  createdAt: number;
  updatedAt: number;
}

// ============================================================
// Task
// ============================================================

/**
 * Individual task stored at {workspaceRootPath}/queue/tasks/{task-id}.json
 */
export interface QueueTask {
  /** Unique task ID: tsk-{YYMMDD}-{random8hex} */
  id: string;

  /** Task type slug — links to the type definition */
  typeSlug: string;

  /** Resolved dedup ID (from dedupTemplate + data). Used for idempotent upserts. */
  dedupId?: string;

  /** Human-readable task title */
  title: string;

  /** Current lifecycle state ID (must be valid for the task's type) */
  state: string;

  /** Numeric priority (lower = higher priority). Optional. */
  priority?: number;

  /** Typed data payload matching the type's field schema */
  data: Record<string, unknown>;

  /** Labels (bare IDs or 'id::value' format, reuses workspace label system) */
  labels: string[];

  /** Session that created this task (for traceability) */
  sourceSessionId?: string;

  /** Sessions spawned from or referencing this task */
  linkedSessionIds: string[];

  /** Timestamps */
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;

  /** Provenance: 'agent' or 'user' */
  createdBy: 'agent' | 'user';
}

// ============================================================
// Input Types (for CRUD operations)
// ============================================================

/**
 * Input for creating a new task type
 */
export interface CreateTaskTypeInput {
  name: string;
  description: string;
  icon?: string;
  tagline?: string;
  source?: string;
  dedupTemplate?: string;
  fields: Record<string, TaskFieldDefinition>;
  states: TaskStateConfig[];
  displayTemplate?: string;
}

/**
 * Input for creating a new task
 */
export interface CreateTaskInput {
  typeSlug: string;
  title: string;
  data: Record<string, unknown>;
  priority?: number;
  labels?: string[];
  sourceSessionId?: string;
  state?: string;
  /** Explicit dedup ID (overrides dedupTemplate resolution) */
  dedupId?: string;
}

/**
 * Input for updating an existing task
 */
export interface UpdateTaskInput {
  title?: string;
  state?: string;
  priority?: number;
  data?: Record<string, unknown>;
  labels?: string[];
}

// ============================================================
// Filter / Query Types
// ============================================================

/**
 * Filter options for listing tasks
 */
export interface QueueTaskFilter {
  /** Filter by task type slug */
  typeSlug?: string;

  /** Filter by state ID */
  state?: string;

  /** Filter by state category ('open' or 'closed') */
  stateCategory?: TaskStateCategory;

  /** Filter by labels (tasks must have ALL specified labels) */
  labels?: string[];

  /** Filter by priority (exact match) */
  priority?: number;

  /** Filter by creation date range (unix timestamps in ms) */
  createdAfter?: number;
  createdBefore?: number;

  /** Maximum number of results */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

/**
 * Summary statistics for the queue
 */
export interface QueueStats {
  /** Total task count */
  total: number;

  /** Counts by state category */
  byCategory: { open: number; closed: number };

  /** Counts by task type slug */
  byType: Record<string, { total: number; open: number; closed: number }>;
}
