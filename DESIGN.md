# DESIGN.md — Archive Design System

> Linear-inspired, monochrome, dark-only design language for the Archive UI.
> **For AI agents and humans:** follow this file when building or extending any UI surface.
> Source of truth: `frontend/app/globals.css` (tokens) + existing component code (patterns).
> Tooling/stack rules live in `AGENTS.md` §7; behavioral interaction rules in `AGENTS.md` §6.E–§6.G.

## 1. Principles

1. **Hierarchy comes from luminance, not color.** Surfaces step from near-black to slightly-less-black; text steps through 4 brightness tiers. Never use color to mean "important".
2. **Borders are hairlines of light.** Translucent white (`rgba(255,255,255,0.04–0.08)`), never solid gray. Borders whisper; they don't outline.
3. **No decorative color.** The only saturated pixels are status: success green, destructive pink, the progress gradient. Everything else is grayscale.
4. **Data interactions are instant.** Tables, log viewers, list selection, menus: zero animation, zero layout shift (`transition-none`). Motion belongs to navigation and surface hover only.
5. **Anti-slop.** No buzzword copy, no decorative badges ("Vault Online"), no emoji in UI chrome, no `alert()` — use `toast.success` / `toast.error`.

## 2. Color tokens (CSS variables)

Defined in `globals.css` (`:root`/`.dark` identical — dark-only), mapped to Tailwind via `@theme inline`.

| Token | Value | Used for |
|---|---|---|
| `--background` | `#08090a` | Page canvas |
| `--card` | `#0f1011` | Cards, panels, sections |
| `--popover` | `#0f1011` | Dropdowns, dialogs |
| `--muted` | `#18191a` | Muted fills |
| `--muted-foreground` | `#8a8f98` | Secondary text |
| `--primary` | `rgba(255,255,255,0.05)` | Primary buttons (translucent white, **not** Linear indigo) |
| `--destructive` | `#f91880` | Destructive actions/errors |
| `--border` | `rgba(255,255,255,0.05)` | Standard hairline |
| `--input` | `rgba(255,255,255,0.08)` | Input borders |
| `--ring` | `rgba(255,255,255,0.15)` | Focus rings |
| `--sidebar` | `#000000` | Dock background (overlaid w/ `bg-[#0c0d0e]/80` glass) |

## 3. Working palette (literal tiers — what components actually use)

When extending an existing view, match the literals already in that view. These are the canonical tiers (usage counts from the codebase):

| Role | Value | Tailwind literal |
|---|---|---|
| Page canvas | `#08090a` | `bg-[#08090a]` |
| Card / panel | `#0f1011` | `bg-[#0f1011]` |
| Dock glass | `#0c0d0e` @ 80% + blur | `bg-[#0c0d0e]/80 backdrop-blur-2xl` |
| Raised fill | `#121316` | `bg-[#121316]` |
| Text — headline/active | `#ffffff` | `text-[#ffffff]` |
| Text — primary | `#f7f8f8` | `text-[#f7f8f8]` |
| Text — secondary/data | `#d0d6e0` | `text-[#d0d6e0]` |
| Text — muted | `#8a8f98` | `text-[#8a8f98]` |
| Text — faint labels | `#62666d` | `text-[#62666d]` |
| Success | `#00ba7c` | `text-[#00ba7c]` / `bg-[#00ba7c]` |
| Destructive | `#f91880` | `text-[#f91880]` |
| Progress gradient | `#4c8dff → #7ab6ff → #9ecbff` | `.kinetics-progress-fill` class |

## 4. Borders & fills (alpha ladder)

| Alpha | Use |
|---|---|
| `rgba(255,255,255,0.015)` | Inset stat wells inside cards |
| `rgba(255,255,255,0.02)` | Input/search-field backgrounds |
| `rgba(255,255,255,0.03)` | Subtle hover background (table rows, secondary hover) |
| `rgba(255,255,255,0.05)` | Standard border; active nav/hover fills |
| `rgba(255,255,255,0.06)` | Strong hover fills |
| `rgba(255,255,255,0.08)` | Emphasized borders (inputs, focus-within border targets) |
| `rgba(255,255,255,0.12–0.2)` | Hover border lift on cards/buttons |

## 5. Shape & elevation

- **Radius ladder:** `rounded-[8px]` cards/panels · `rounded-[6px]` inner controls/inputs/buttons · `rounded-[4px]` tiny chips · `rounded-[9999px]` pills/dock.
- **Card shadow (hover lift):** `0 10px 24px -8px rgba(0,0,0,0.7)`.
- **Dock shadow:** `0 16px 50px rgba(0,0,0,0.65)` + inset specular `inset 0 1px 1.5px rgba(255,255,255,0.22)`.
- **Inset speculars** (`inset 0 1px 1px rgba(255,255,255,0.2–0.25)`) simulate top-lit glass on raised elements.

## 6. Typography

- **UI:** Inter via `next/font`. Body 15px/24px w400.
- **Mono:** `"Berkeley Mono", var(--font-mono-code) [JetBrains Mono], Monaco, ...` — 13px/21px. All data values (URLs, hashes, credentials, sizes) render in `font-mono`.
- **Headings:** h1 24px/31.9px, h2 20px/26.6px, h3 16px/24px — all w590, `#ffffff`/`#f7f8f8`.
- **Sizes in components:** `text-xs` (12px) default for dense data, `text-[11px]` for uppercase labels (`uppercase tracking-wide text-[#62666d]`), `text-sm` (14px) for body/nav.

## 7. Motion

- **Spring tokens** (Kinetics, kinetics.colorion.co): `--spring-easing` `linear(...)` curve; `--spring-duration` 520ms, fast 260ms.
- **Page/tab enter:** `.apple-tab-enter` — 200ms `cubic-bezier(0.16, 1, 0.3, 1)`, fade + 6px rise.
- **View enter:** `.spring-enter` (480ms overshoot) + `.kinetics-stagger` (40ms per-child delays).
- **Surface hover:** unwrapped `.kinetics-card` surfaces retain their lift. `MotionSurface` replaces that lift with a monochrome travelling border so the card and beam never move apart; `.spring-interactive` retains its press feedback.
- **Shared beam material:** `components/motion-surface.tsx` wraps the login card and one summary/header per main view; archives also wraps its upload panel. A 2.5-second first-visible sweep runs once per mount; hover or contained keyboard focus reactivates it. Actual busy states switch to a contained 3-second breathing border. Strength is 0.30 for lines and 0.22 for breathing; theme is always dark/mono, with outer bloom disabled.
- **Primary-action sheen:** `.motion-sheen` gives selected primary actions one 700ms white-light sweep on hover or keyboard focus. Disabled actions have no sheen. Do not apply it to table actions, menu items, destructive buttons, or tabs.
- **Loading:** `.kinetics-progress-fill` + `.kinetics-progress-shimmer` mark ongoing uploads/indexing. Shimmer inside a `MotionSurface` pauses when that surface is not animating.
- **THE ZERO-ANIMATION RULE:** clicking/interacting with data rows, log entries, validator items, and profile menus is `transition-none` and instant. Never animate selection.
- **Motion budget:** no idle decorative loops. Beams stop when offscreen, when the document is hidden, or when reduced motion is requested; observers, listeners, and reveal timers are cleaned up on unmount. `prefers-reduced-motion: reduce` also hides beam/sheens in CSS; content and controls remain usable.

- **Effect sources:** [`border-beam`](https://libraries.dev) supplies the shared line/breathing material. Sheen and shimmer use local CSS, with no extra dependencies. External examples are references, not automatic permission to add shaders, asset downloads, or new accent colors.

## 8. Component recipes

- **Card/section:** `<section class="rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[#0f1011] p-4">`; stat wells inside: `rounded-[8px] border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3.5 py-2.5` with label `text-[11px] uppercase tracking-wide text-[#62666d]` and value `text-lg font-semibold tabular-nums text-[#d0d6e0]`.
- **Search/input:** flex row, `rounded-[6px] border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-3.5 py-2`, `focus-within:border-[rgba(255,255,255,0.2)]`, lucide icon at `size-4 text-[#8a8f98]`, mono input text.
- **Segmented selectors:** reuse `components/ui/segmented-control.tsx` for validator modes/statuses, search modes, and cookie formats. Native button groups expose `aria-pressed`; reserve the same border in selected/unselected states. Mode/format segments have equal widths and fixed heights (36px group, 28px compact), with explicit 16px text line-height. Dense status filters may use intrinsic column widths. Keep labels on one line; hide decorative icons below `sm` rather than squeezing text. Put availability notes outside the segments.
- **Peer controls:** match input/button heights within each toolbar (40px search, 36px admin forms, 32px compact validator actions). Wrap whole action groups below headings on small screens. Inputs use `min-w-0`; tables scroll inside their own container, not the page. Center empty/loading messages outside a wide table's scroll area.
- **Dialogs:** cap height to the viewport and allow vertical scrolling; wrap titles, identities, source paths, and footers without squeezing text into narrow columns. Associate labels with unique input IDs. Keep menu opening and data selection instant.
- **Table rows:** `border-b border-[rgba(255,255,255,0.03)] hover:bg-[rgba(255,255,255,0.03)] transition-none`; mono cells `truncate` + `title` tooltip.
- **Page shell:** max width `max-w-[1500px]`, `px-4 md:px-6 lg:px-8 pt-6 pb-28` (bottom clearance for the floating dock), content wrapped in `.apple-tab-enter`.
- **Mobile dock:** constrain the island to viewport width minus 32px; scroll the navigation strip horizontally while keeping the profile trigger outside it. Reveal active/focused routes, preserve 36px targets, and account for the bottom safe area. Decorative hover tooltips remain desktop-only.
- **Profile popup:** the compact dock account menu is 224px wide, centered above its avatar with a collision-aware 12×6px pointer. Use a 12px trigger offset and 16px viewport padding; let the panel shift inward on narrow screens while its pointer stays anchored to the avatar. Keep the outer arrow unclipped and scroll the inner menu on short screens. Highlight the open avatar subtly and hide its hover tooltip while the menu is open. Opening, closing, and selection remain instant.
- **Empty states:** `.app-empty-state` — centered column, muted text, one hint line.
- **Page header:** `.app-page-header` — baseline row, hairline bottom border.
- **Primitives:** shadcn/ui new-york style in `components/ui/`; icons lucide-react only (`size-3.5`/`size-4`/`size-5`); toasts via sonner; forms via react-hook-form + zod; conditional classes always through `cn()`.

## 9. Icons & assets — where they come from

| Asset | Source | How it's used |
|---|---|---|
| UI icons | `lucide-react` npm package (in-JSX React components) | `<Icon className="size-3.5/4/5" />` — the only stroke-icon set |
| 3D illustration icons | **3dicons.co** (free license) — static WebPs committed at `frontend/public/icons/*-3d.webp` | Rendered by `Icon3D` (`components/kinetics-ui.tsx`): glass tile (`border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)]` + inset specular) + float animation. To add one: drop the WebP in `public/icons/` and register it in the `ICON_PATHS` map |
| Fonts | Inter + JetBrains Mono via `next/font/google` (downloaded and self-hosted at build; Berkeley Mono is a locally-installed fallback-first mono face) | `app/layout.tsx` |
| Favicon | `app/favicon.ico` | App Router convention |
| Motion effects | [libraries.dev](https://libraries.dev) (`border-beam` via `MotionSurface`) + local CSS sheen/shimmer | See §7 |

No remote asset URLs at runtime — everything ships inside the bundle/image. Scaffold leftovers (`file/globe/next/vercel/window.svg`) and an unused `shield.webp` were deleted; don't re-add Next.js defaults.

## 10. Do / Don't

| Do | Don't |
|---|---|
| Reuse the literal tiers in §3/§4 | Invent new grays or alpha steps |
| Match the literals already in the view you extend | Mix CSS-variable tokens and literals inconsistently within one view |
| `toast.success` / `toast.error` | `alert()`, `window.confirm` |
| lucide-react | Any second icon set, or emoji as icons |
| `.apple-tab-enter` on page roots | Animating data selection or menus |
| `font-mono` for data | New font families |
| Plain, concrete labels ("Total", "Not Checked") | Buzzwords, status badges, marketing copy |

## 11. Deviations from the upstream Linear reference

- `--primary` is translucent white, not Linear indigo `#5e6ad2` — the vault is deliberately accent-less.
- Destructive is shadcn pink `#f91880`, not Linear's alert palette.
- Mono text is Berkeley Mono/JetBrains Mono (Linear is all-Inter).
- Progress/scroll accents introduce a blue gradient (`#4c8dff→#9ecbff`) — the one sanctioned "colorful" element, for long-running operations only.
