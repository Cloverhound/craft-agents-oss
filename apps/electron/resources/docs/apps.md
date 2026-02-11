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
  - `useTheme`
  - `useAppMode`

## UI Component Conventions

Prefer SDK components when they fit:

- `Button`
- `Badge`
- `Card`
- `EmptyState`
- `Spinner`
- `Table`

Use custom UI only where app-specific rendering is required (e.g., specialized ticket rows, timeline layouts).

## Styling Conventions

Use host semantic tokens instead of hardcoded palette values where possible:

- `bg-background`, `text-foreground`
- `border-foreground/10`, `hover:bg-foreground/[0.02]`
- subtle shadows and borders (avoid harsh black outlines)

Layout guidance:

- Use full-height layouts for list/detail shells.
- Empty/loading states should fill available height (`min-h-full` within scroll container patterns).
- Keep spacing and control heights consistent with host primitives (`h-8`, `h-9`, `rounded-md`, etc.).

## Compilation and Build

Compile apps through the shared app compiler flow (same path used by host tooling). Avoid custom one-off build scripts unless necessary.

If Tailwind output appears incorrect:

1. Verify Tailwind source scanning directives in `src/index.css`.
2. Verify compiler invokes Tailwind CLI correctly.
3. Recompile and inspect generated CSS for expected utility classes.

## Validation Checklist

Before finalizing app changes:

1. App compiles successfully.
2. UI aligns with host styling conventions.
3. Empty/loading/error states render correctly.
4. Navigation between views works.
5. Data hooks handle loading/error/success cleanly.
6. No regressions in existing app scripts.

