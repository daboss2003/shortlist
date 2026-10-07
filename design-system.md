# Design system

Binding for all UI in this repo. Goal: a calm, credible, professional product. Applicants must
trust the public apply page enough to hand over their CV; employers must trust the rankings.
Think Greenhouse/Ashby/Linear — quiet, precise, information-dense where it matters.

## Tokens (`src/app/globals.css`, Tailwind v4 `@theme`)

| Role | Class | Use |
|---|---|---|
| Page background | `bg-canvas` | `<body>`, behind cards |
| Surface | `bg-surface` | cards, tables, inputs, header bars |
| Subtle fill | `bg-subtle` | table header row, hover rows, icon wells |
| Borders | `border-line` / `border-line-strong` | dividers / input + secondary button borders |
| Text | `text-ink` / `text-ink-muted` / `text-ink-faint` | primary / secondary / tertiary (faint = metadata only) |
| Brand | `bg-brand`, `hover:bg-brand-hover`, `bg-brand-soft`, `text-brand-ink` | the ONE primary action per view, links, selection |
| Status | `success`, `warning`, `danger` (+ `-soft`) | scores, statuses, destructive actions |

Light theme only (deliberate). No gradients, no glassmorphism, no emoji, no decorative blobs.
Icons: `lucide-react` only, `size-4` inline (buttons size them automatically), `aria-hidden` when decorative.

## Type & spacing

- Font: Geist Sans (`font-sans`), Geist Mono for ids/numbers only if needed. Use `tabular-nums` for scores/counts.
- Employer app body text `text-sm`; public pages body `text-base`. Headings: page title `text-2xl font-semibold tracking-tight`,
  section title `text-base font-semibold`, eyebrow/meta `text-xs font-medium text-ink-muted uppercase tracking-wide` (sparingly).
- Spacing from Tailwind's 4px scale only. Page gutters `px-4 sm:px-6 lg:px-8`; content max width `max-w-6xl` (dashboard),
  `max-w-3xl` (public apply, forms). Vertical rhythm between page sections `gap-6`/`space-y-6`.
- Radius: `rounded-lg` controls, `rounded-xl` cards. Shadow: `shadow-xs` cards, `shadow-sm` buttons. Nothing heavier.

## Components (`src/components/ui/`) — compose these, don't restyle ad hoc

- `button.tsx`: `Button`, `ButtonLink`, `buttonClass(variant, size)` — variants primary | secondary | ghost | danger; sizes sm | md | lg.
- `field.tsx`: `Input`, `Textarea`, `Select`, `Label`, `Field` (label + hint/error with ids; set `aria-invalid` + `aria-describedby` on the control).
- `card.tsx`: `Card`, `CardHeader` (title/description/actions), `CardBody`.
- `badge.tsx`: `Badge` with tone neutral | brand | success | warning | danger.
- `feedback.tsx`: `Spinner`, `LoadingBlock` (Suspense fallback), `Alert` (info | success | warning | danger), `EmptyState`.
- Labels and score colour: `src/lib/format.ts` (`*_LABELS`, `scoreTone`, `formatDate`, `formatBytes`). Never hard-code enum labels.

## Patterns

- **Tables** for candidate lists (dense rows, `text-sm`, sticky-ish header in `bg-subtle`, row hover `hover:bg-subtle/60`),
  wrapped in `relative overflow-x-auto` so the page never scrolls horizontally at 375px (`relative` is required:
  without it, absolutely positioned descendants such as `sr-only` labels escape the scroll box and widen the page).
- **Score**: integer 0–100 in a pill coloured by `scoreTone` (≥75 success, 50–74 warning, <50 danger), `tabular-nums`.
  Pending/processing shows a spinner + "Analyzing", failed shows danger badge "Failed" with the error on hover/detail.
- **Every screen** ships loading (Suspense `LoadingBlock`), empty (`EmptyState` with a CTA), error (`Alert tone="danger"` with retry
  where retryable) and populated states. Forms show pending state on submit (disabled button + spinner) and field-level errors.
- **Destructive actions** use `variant="danger"` and a confirm step.
- **Public pages** (apply): company name is the hero, not our product. Show job facts (location, type, department), full
  description/requirements, a clear privacy line ("Your CV is shared only with {Company} for this role"), a calm success
  screen. "Powered by {APP_NAME}" small in the footer.
