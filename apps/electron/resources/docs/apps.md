# Apps Documentation

This guide defines how to create and maintain custom Apps in Craft Agent so they remain consistent, reliable, and easy for agents to evolve.

## What is an App?

An App is a React micro-application stored in:

`~/.craft-agent/workspaces/{workspaceId}/apps/{slug}/`

Typical structure:

- `config.json` — app metadata, mode, views, scripts
- `src/` — React UI (`App.tsx`, views, styles)
- `scripts/` — data/action scripts called from the UI
- `dist/` — compiled output

## Before Creating or Modifying Apps

1. Read this document first.
2. Follow existing app patterns in the workspace.
3. Prefer additive changes over broad refactors.
4. Keep UI aligned with host design tokens and component conventions.

## SDK Usage Conventions

Use `@craft-agent/app-sdk` as the default integration layer:

- Navigation/state:
  - `initAppSdk()`
  - `AppProvider`
  - `useAppNavigate`
- Data/actions:
  - `useAppData`
  - `useAppAction`
- Host integration:
  - `useHostNavigate`
  - `useOpenUrl`
  - `useTheme`
  - `useAppMode`

Recommended defaults:

- Initialize SDK once in `src/main.tsx` with `initAppSdk()`.
- Keep view routing in `src/App.tsx` and push data loading into view components.
- Use `useAppData` for read paths and `useAppAction` for write/mutation paths.
- Keep script output shapes stable (explicit keys, predictable empty states).

## UI Component Conventions

Prefer SDK components when they fit:

- `Button`
- `Badge`
- `Card`
- `EmptyState`
- `Spinner`
- `Table`

Use custom UI only where app-specific rendering is required (e.g., specialized ticket rows, timeline layouts).

General UX guidance:

- Show explicit empty states (not blank panes).
- Surface actionable errors (include next-step hints where possible).

## Styling Conventions

Use host semantic tokens instead of hardcoded palette values where possible:

- `bg-background`, `text-foreground`
- `border-foreground/10`, `hover:bg-foreground/[0.02]`
- subtle shadows and borders (avoid harsh black outlines)

Layout guidance:

- Use full-height layouts for list/detail shells.
- Empty/loading states should fill available height (`min-h-full` within scroll container patterns).
- Keep spacing and control heights consistent with host primitives (`h-8`, `h-9`, `rounded-md`, etc.).

`src/index.css` should include Tailwind import + source scan and theme tokens:

```css
@import "tailwindcss";
@source "./src";

@theme {
  --color-background: var(--app-color-background, oklch(98.5% 0 0));
  --color-foreground: var(--app-color-foreground, oklch(27.4% 0.006 286.033));
  --color-accent: var(--app-color-accent, oklch(70.7% 0.165 254.624));
  --color-destructive: var(--app-color-destructive, oklch(57.7% 0.245 27.325));
}
```

Without these semantic tokens, classes like `bg-background` / `text-foreground` / `text-destructive` may not render as expected.

## External Links and Buttons

Use one of these patterns:

1. **Anchor links (`<a href="...">`)** for inline/document-style links.
2. **Buttons/actions** should call `useOpenUrl()` from `@craft-agent/app-sdk`.

Example:

```tsx
import { useOpenUrl } from "@craft-agent/app-sdk";

function DocsButton() {
  const { openUrl } = useOpenUrl();
  return (
    <button onClick={() => openUrl("https://agents.craft.do/docs/apps")}>
      Open docs
    </button>
  );
}
```

Supported external URL schemes are routed through the host shell:

- `https:`
- `http:`
- `mailto:`
- `craftagents:`

Notes:

- App links are opened by host-side handling (`APP_OPEN_URL`) in `AppHostPage`.
- The app webview preload (`app-preload.ts`) intercepts external anchor clicks and forwards them to host.
- If links stop opening after preload changes, rebuild preload artifacts (`preload.cjs` and `app-preload.js`) before debugging app code.

## Compilation and Build

Compile apps through the shared app compiler flow (same path used by host tooling). Avoid custom one-off build scripts unless necessary.

If Tailwind output appears incorrect:

1. Verify Tailwind source scanning directives in `src/index.css`.
2. Verify compiler invokes Tailwind CLI correctly.
3. Recompile and inspect generated CSS for expected utility classes.

Important:

- Don’t ship placeholder `dist/styles.css`; compile real Tailwind output.
- Keep app bundles self-consistent with host runtime expectations (avoid ad-hoc bundling shortcuts that change module resolution behavior).

## Validation Checklist

Before finalizing app changes:

1. App compiles successfully.
2. UI aligns with host styling conventions.
3. Empty/loading/error states render correctly.
4. Navigation between views works.
5. Data hooks handle loading/error/success cleanly.
6. No regressions in existing app scripts.
7. External links open correctly from both anchor tags and button-driven actions.
