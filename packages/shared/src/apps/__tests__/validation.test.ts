import { describe, it, expect } from 'bun:test';
import { validateAppConfig } from '../validation.ts';

describe('validateAppConfig', () => {
  const validConfig = {
    slug: 'my-app',
    name: 'My App',
    views: [{ id: 'list', path: '/list', title: 'List View' }],
  };

  it('passes for a valid minimal config', () => {
    const result = validateAppConfig(validConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('passes for a config with all optional fields', () => {
    const full = {
      slug: 'full-app',
      name: 'Full App',
      description: 'A full featured app',
      icon: '📊',
      version: '1.0.0',
      credentials: ['xero', 'znuny'],
      sidebar: {
        position: 1,
        badge: { script: 'badge-count', interval: 30 },
      },
      views: [
        { id: 'list', path: '/list', title: 'List', script: 'fetch-list' },
        { id: 'detail', path: '/detail/:id', title: 'Detail', script: 'fetch-detail' },
      ],
    };
    const result = validateAppConfig(full);
    expect(result.valid).toBe(true);
  });

  it('fails when slug is missing', () => {
    const result = validateAppConfig({ name: 'No Slug', views: [{ id: 'v', path: '/', title: 'V' }] });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes('slug'))).toBe(true);
  });

  it('fails when name is missing', () => {
    const result = validateAppConfig({ slug: 'test', views: [{ id: 'v', path: '/', title: 'V' }] });
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes('name'))).toBe(true);
  });

  it('fails when views is missing', () => {
    const result = validateAppConfig({ slug: 'test', name: 'Test' });
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes('views'))).toBe(true);
  });

  it('fails when views array is empty', () => {
    const result = validateAppConfig({ slug: 'test', name: 'Test', views: [] });
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes('views'))).toBe(true);
  });

  it('fails for slug with uppercase letters', () => {
    const result = validateAppConfig({ ...validConfig, slug: 'MyApp' });
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes('slug'))).toBe(true);
  });

  it('fails for slug with spaces', () => {
    const result = validateAppConfig({ ...validConfig, slug: 'my app' });
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes('slug'))).toBe(true);
  });

  it('fails for slug with underscores', () => {
    const result = validateAppConfig({ ...validConfig, slug: 'my_app' });
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes('slug'))).toBe(true);
  });

  it('fails when view is missing id', () => {
    const result = validateAppConfig({
      slug: 'test',
      name: 'Test',
      views: [{ path: '/', title: 'V' }],
    });
    expect(result.valid).toBe(false);
  });

  it('fails when view is missing path', () => {
    const result = validateAppConfig({
      slug: 'test',
      name: 'Test',
      views: [{ id: 'v', title: 'V' }],
    });
    expect(result.valid).toBe(false);
  });

  it('fails when view is missing title', () => {
    const result = validateAppConfig({
      slug: 'test',
      name: 'Test',
      views: [{ id: 'v', path: '/' }],
    });
    expect(result.valid).toBe(false);
  });

  it('returns specific error paths', () => {
    const result = validateAppConfig({ slug: 'INVALID', name: '', views: [] });
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBeGreaterThanOrEqual(2);
  });
});
