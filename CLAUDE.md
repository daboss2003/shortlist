@AGENTS.md

# CV Review Pipeline

Employers create a job, share its public link, and collect CVs (or bulk-upload CVs they already have).
Each CV is parsed, turned into a structured candidate profile and ranked against the job by an AI
provider chosen from env (Gemini by default; OpenAI, Claude, Groq, any OpenAI-compatible API).
Employers review ranked candidates and export them as CSV / XLSX / ZIP of original CVs.

## Stack

Next.js 16 App Router (Cache Components ON) · React 19 · TypeScript · Tailwind v4 · SQLite via
better-sqlite3 + Drizzle · Vercel AI SDK v7 (`generateText` + `Output.object`) · Vitest.

## Commands

`pnpm dev` · `pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm db:generate` (after editing `src/db/schema.ts`; migrations auto-apply on first DB import).
Run `npx next typegen` if `PageProps`/`LayoutProps`/`RouteContext` globals are missing.

## Layout

- `src/db/schema.ts` — tables + enum constants + inferred types. `src/db/index.ts` — `db` singleton (runs migrations).
- `src/lib/auth/` — scrypt passwords, DB sessions (sha256-hashed token in `sessions`), `requireEmployer()` / `getCurrentEmployer()`.
- `src/lib/data/` — tenant-scoped read DAL (`jobs.ts`, `candidates.ts`).
- `src/lib/candidates/intake.ts` — validate + store a CV, insert `pending` candidate (shared by public apply + employer upload).
- `src/lib/pipeline/` — background extraction + AI analysis (`scheduleCandidateProcessing`).
- `src/lib/ai/` — `schemas.ts` (zod profile/evaluation), provider registry, prompts, `status.ts`.
- `src/lib/cv/` — file-type sniffing, PDF/DOCX/TXT text extraction. `src/lib/storage.ts` — local CV files.
- `src/lib/export/` — CSV/XLSX/ZIP builders. `src/lib/format.ts` — all human-readable labels.
- `src/components/ui/` — design-system primitives. See `design-system.md` (binding).

## Conventions

- **Tenancy:** every employer query filters by `companyId` from `requireEmployer()` / `getCurrentEmployer()`, never from input.
  `candidates.company_id` is denormalized for this. A foreign id must behave exactly like a missing one (404 / notFound()).
- **Auth:** pages + Server Actions call `requireEmployer()`; Route Handlers call `getCurrentEmployer()` and return 401 JSON.
  Mutating cookie-auth Route Handlers also check `isSameOrigin(request)` (`src/lib/http.ts`). Public routes carry an
  `Intentional: public because …` comment.
- **Cache Components:** pages render a `<Suspense fallback={<LoadingBlock/>}>` around an async inner component; all
  request-time work (cookies, `await params`, `searchParams`, DB reads) happens inside it. Never await the session at a
  layout's top level. DAL reads (sync better-sqlite3) must only run after a request-time API has been awaited, otherwise
  they'd be prerendered at build time.
- **Mutations:** forms use Server Actions (`"use server"` files named `actions.ts` next to the route); file uploads,
  downloads and exports use Route Handlers. Validate all input with zod at the boundary.
- **AI output is untrusted** (CV text can contain prompt injection): it's validated by zod schemas, scores are clamped
  0–100, and it's rendered as text only (never `dangerouslySetInnerHTML`).
- **Tests:** Vitest with an in-memory SQLite per test file (`test/setup.ts`, factories in `test/factories.ts`).
  Never call a real AI provider in tests — use `MockLanguageModelV4` from `ai/test`.
- `Intentional:` comments mark deliberate oddities; don't "fix" them.
