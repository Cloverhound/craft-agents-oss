/**
 * App Validation
 *
 * Zod schemas for validating AppConfig and related types.
 */

import { z } from 'zod';

// ============================================================
// Schemas
// ============================================================

export const appViewConfigSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  title: z.string().min(1),
  script: z.string().optional(),
});

export const appConfigSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  version: z.string().optional(),
  credentials: z.array(z.string()).optional(),
  mode: z.enum(['explore', 'execute']).optional(),
  sidebar: z
    .object({
      position: z.number().optional(),
      badge: z
        .object({
          script: z.string(),
          interval: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  views: z.array(appViewConfigSchema).min(1, 'At least one view is required'),
});

// ============================================================
// Validation Function
// ============================================================

/**
 * Validate an app configuration object.
 * Returns { valid: true } if valid, or { valid: false, errors: [...] } with
 * human-readable error messages.
 */
export function validateAppConfig(config: unknown): { valid: boolean; errors?: string[] } {
  const result = appConfigSchema.safeParse(config);
  if (result.success) return { valid: true };
  return {
    valid: false,
    errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}
