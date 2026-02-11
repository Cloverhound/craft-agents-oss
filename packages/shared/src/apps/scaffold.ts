/**
 * App Scaffolding
 *
 * Creates the directory structure and starter files for a new app.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AppConfig } from './types.ts';
import { getWorkspaceAppsPath } from './storage.ts';

/**
 * Scaffold a new app in the workspace.
 *
 * Creates:
 *   apps/{slug}/
 *     config.json
 *     src/
 *       App.tsx
 *       views/{viewId}.tsx   (one per view)
 *       index.css
 *     scripts/
 *
 * @throws Error if the app directory already exists
 */
export function scaffoldApp(workspaceRootPath: string, config: AppConfig): string {
  const appsDir = getWorkspaceAppsPath(workspaceRootPath);
  const appDir = join(appsDir, config.slug);

  if (existsSync(appDir)) {
    throw new Error(`App directory already exists: ${appDir}`);
  }

  // Create directory structure
  mkdirSync(join(appDir, 'src', 'views'), { recursive: true });
  mkdirSync(join(appDir, 'scripts'), { recursive: true });

  // Write config.json
  writeFileSync(join(appDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');

  // Write index.css with @source directive so Tailwind scans the app's source files
  writeFileSync(
    join(appDir, 'src', 'index.css'),
    `@import "tailwindcss";\n@source "./src";\n`,
    'utf-8',
  );

  // Write view component files and starter scripts
  const generatedScripts = new Set<string>();
  for (const view of config.views) {
    const viewContent = generateViewComponent(view.id, view.title, view.script);
    writeFileSync(join(appDir, 'src', 'views', `${view.id}.tsx`), viewContent, 'utf-8');

    // Generate a starter script for each unique script reference
    if (view.script && !generatedScripts.has(view.script)) {
      generatedScripts.add(view.script);
      const scriptContent = generateStarterScript(view.script);
      writeFileSync(join(appDir, 'scripts', `${view.script}.js`), scriptContent, 'utf-8');
    }
  }

  // Write App.tsx (router)
  const appTsx = generateAppComponent(config);
  writeFileSync(join(appDir, 'src', 'App.tsx'), appTsx, 'utf-8');

  // Write main.tsx (entry point — mounts App to #root, wrapped in AppProvider)
  const defaultView = config.views[0]?.id ?? 'default';
  writeFileSync(join(appDir, 'src', 'main.tsx'), generateMainEntry(defaultView), 'utf-8');

  return appDir;
}

/**
 * Generate the main.tsx entry point that mounts the app to #root.
 */
function generateMainEntry(defaultView: string): string {
  return [
    `import React from 'react';`,
    `import { createRoot } from 'react-dom/client';`,
    `import { initAppSdk, AppProvider } from '@craft-agent/app-sdk';`,
    `import App from './App';`,
    ``,
    `// Initialize the bridge before rendering (connects to host via preload API)`,
    `initAppSdk();`,
    ``,
    `const root = createRoot(document.getElementById('root')!);`,
    `root.render(`,
    `  <AppProvider defaultView="${defaultView}">`,
    `    <App />`,
    `  </AppProvider>,`,
    `);`,
    ``,
  ].join('\n');
}

/**
 * Generate a view component file.
 */
function generateViewComponent(viewId: string, title: string, script?: string): string {
  const componentName = toPascalCase(viewId) + 'View';
  const lines: string[] = [];

  lines.push(`import React from 'react';`);

  if (script) {
    lines.push(`import { useAppData } from '@craft-agent/app-sdk';`);
  }

  lines.push('');
  lines.push(`export default function ${componentName}() {`);

  if (script) {
    lines.push(`  const { data, loading, error, refetch } = useAppData('${script}');`);
    lines.push('');
    lines.push('  if (loading) return <div className="p-4">Loading...</div>;');
    lines.push('  if (error) return <div className="p-4 text-red-500">Error: {error}</div>;');
    lines.push('');
  }

  lines.push(`  return (`);
  lines.push(`    <div className="p-4">`);
  lines.push(`      <h1 className="text-xl font-bold mb-4">${title}</h1>`);

  if (script) {
    lines.push(`      <pre className="text-sm">{JSON.stringify(data, null, 2)}</pre>`);
  } else {
    lines.push(`      <p>Welcome to ${title}</p>`);
  }

  lines.push(`    </div>`);
  lines.push(`  );`);
  lines.push(`}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate the root App.tsx component with routing.
 */
function generateAppComponent(config: AppConfig): string {
  const lines: string[] = [];

  lines.push(`import React from 'react';`);
  lines.push(`import { useAppNavigate } from '@craft-agent/app-sdk';`);

  // Import view components
  for (const view of config.views) {
    const componentName = toPascalCase(view.id) + 'View';
    lines.push(`import ${componentName} from './views/${view.id}';`);
  }

  lines.push('');
  lines.push(`export default function App() {`);
  lines.push(`  const { currentView, params } = useAppNavigate();`);
  lines.push('');

  // Switch statement for views
  lines.push(`  const renderView = () => {`);
  lines.push(`    switch (currentView) {`);
  for (const view of config.views) {
    const componentName = toPascalCase(view.id) + 'View';
    lines.push(`      case '${view.id}':`);
    lines.push(`        return <${componentName} />;`);
  }
  lines.push(`      default:`);
  const defaultComponent = toPascalCase(config.views[0]!.id) + 'View';
  lines.push(`        return <${defaultComponent} />;`);
  lines.push(`    }`);
  lines.push(`  };`);
  lines.push('');
  lines.push(`  return (`);
  lines.push(`    <div className="relative z-10 min-h-screen bg-background text-foreground">`);
  lines.push(`      {renderView()}`);
  lines.push(`    </div>`);
  lines.push(`  );`);
  lines.push(`}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a starter data-fetching script.
 *
 * Scripts run in a child process with proxy env vars for authenticated API access.
 * They receive params via PARAM_{KEY} env vars and output JSON to stdout.
 */
function generateStarterScript(scriptName: string): string {
  return `#!/usr/bin/env node
/**
 * ${scriptName} — data-fetching script
 *
 * Runs in a child process with proxy env vars for authenticated API access.
 * Params from useAppData() are available as PARAM_{KEY} environment variables
 * (uppercased), or as JSON in CRAFT_PARAMS.
 *
 * Output JSON to stdout — this is returned to the app via useAppData().
 * Errors should go to stderr + process.exit(1).
 */

async function main() {
  // Read params from environment (set by useAppData hook)
  // const myParam = process.env.PARAM_MYPARAM || '';

  // TODO: Fetch data from your API
  const result = { message: 'Hello from ${scriptName}' };

  // Output JSON to stdout
  console.log(JSON.stringify(result));
}

main().catch(err => {
  console.error(\`[${scriptName}] \${err.message || err}\`);
  process.exit(1);
});
`;
}

/**
 * Convert a kebab-case or camelCase string to PascalCase.
 */
function toPascalCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
