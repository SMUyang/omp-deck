# Themes

omp-deck ships with three themes:

- **Paper** — warm cream surfaces, rust accent, near-black ink. Engineer's
  notebook aesthetic. Light mode.
- **Slate** — deep slate surfaces, brighter rust accent, calm syntax colors.
  Dark mode.
- **Horizon** — purple-ink dark mode ported from
  [opus-extensions/omp-themes](https://github.com/vincitamore/misc/tree/main/opus-extensions/omp-themes).

Switch in **Settings → Appearance**. Click a card to apply. The whole UI
flips instantly — chat surface, kanban cards, settings tables, badges, code
blocks all driven by the same CSS custom-property system.

## How it works

Every color and font token lives as a CSS custom property in
`apps/web/src/styles.css`:

```css
[data-theme="paper"] {
  --paper: 247 244 238;
  --ink: 26 24 20;
  --accent: 154 52 18;
  /* ... */
  --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

[data-theme="slate"] {
  --paper: 15 19 26;
  --ink: 232 234 237;
  --accent: 249 115 22;
  /* ... */
}
```

Values are space-separated RGB triplets so Tailwind's `<alpha-value>` slot
composes — `bg-paper`, `bg-warn/15`, `border-line/30` all work without
source changes. Tailwind reads each token through
`rgb(var(--paper) / <alpha-value>)` defined in `apps/web/tailwind.config.ts`.

## Persistence

The chosen theme is saved in `localStorage` under `omp-deck:theme`. An
inline `<script>` in `apps/web/index.html`'s head runs **before** React
mounts, reads the stored value, and sets `<html data-theme="…">` — so there
is no flash-of-default. Reload preserves the choice.

## System preference

On first visit (no value in `localStorage`), the pre-paint script reads
`prefers-color-scheme`:

- `dark` → slate.
- otherwise → paper.

Pin a choice by picking a card in Settings. Revert to system preference
with **Match system** (clears the `localStorage` value).

If the OS preference changes while the deck is open and you have no pin,
the theme follows automatically (via a `matchMedia` listener).

## Cross-tab sync

Two deck tabs open. Pick Slate in tab A. Tab B follows within milliseconds
via the browser's `storage` event.

## highlight.js code blocks

Code blocks in chat use `highlight.js` with `atom-one-light` as the base
stylesheet. Slate theme overrides the syntax-token colors via
`[data-theme="slate"] .hljs-keyword { ... }` selectors so code remains
readable on dark.

## Adding a third theme

The architecture supports N themes — v1 ships three.

1. Append a `ThemeDefinition` entry to `THEMES` in
   `apps/web/src/lib/theme.ts`.
2. Add a `[data-theme="<id>"] { … }` block in `apps/web/src/styles.css`
   with the full token list (paper × 4, ink × 4, line × 2, accent × 2,
   success / warn / danger / thinking, font-sans, font-mono).
3. Add the new id to the `THEMES` array in
   `apps/web/index.html`'s pre-paint script.
4. (Optional) Add syntax-token overrides under
   `[data-theme="<id>"] .hljs-…` for code blocks.

Each card in the picker renders its swatches inside an isolated
`data-theme="<id>"` wrapper, so it shows its own palette regardless of
which theme is globally active. No code change needed for the preview to
work.

## Non-goals

- Per-token color picker. Presets only.
- User-uploaded themes. Theme registry is static for v1.
- Density / spacing toggles. Single density.
- Per-workspace theme override.
