# Shortlist — CV collection & AI ranking

Create a job, share its link, and let applicants upload their CV, or upload CVs you already have.
Every CV is turned into a structured candidate profile and ranked against the job by AI. Review the
ranked list, shortlist the people you want, and export them as **CSV**, **Excel** or a **ZIP of their CVs**.

## Quick start

```bash
pnpm install
cp .env.example .env.local      # then add at least one AI key (GEMINI_API_KEY is the default)
pnpm dev                        # http://localhost:3000
```

1. **First admin:** set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12+ characters) in `.env.local`. On server start that
   account is created as the platform admin. Log in at `/login`.
2. Signups are **invite-only**. As the admin, open **Invites** in the dashboard to create a one-time signup link for each
   company (optionally locked to their email), or run `pnpm invite [email] [--days 14]`. Companies sign up with their
   name and website, which is shown to applicants so they know the role is genuine.
3. Create a job: the description, requirements and key skills are what the AI ranks against.
4. Share the **Apply link** from the job page, or use **Upload CVs** for CVs you already have.
5. Candidates appear ranked within a minute. Open one to see the extracted profile and the reasoning behind the score.
6. Select candidates and export them as CSV, Excel or a ZIP of CVs.

The SQLite database and uploaded CVs live in `./data/` (git-ignored). Migrations run automatically.

## Data retention

Each company picks a retention period in **Settings** (Off / 30 / 90 / 180 days; default 90). Once a job has been
closed that long, every candidate on it is permanently deleted: the CV file plus the extracted text, profile and AI
evaluation. The job post itself stays. Reopening a job stops the clock. A sweep runs at boot and hourly, and SQLite's
`secure_delete` overwrites deleted rows on disk. Employers can also delete candidates one at a time, in bulk, or by
deleting the job. Closed jobs accept no new CVs, either from the public link or from employer uploads.

## AI providers

Configured entirely by environment variables. Set one or more keys:

| Provider | Key | Default model (override) |
|---|---|---|
| Google Gemini (**default**) | `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` | `gemini-3.8-flash` (`GEMINI_MODEL`) |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.4-mini` (`OPENAI_MODEL`) |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` (`ANTHROPIC_MODEL`) |
| Groq | `GROQ_API_KEY` | `openai/gpt-oss-120b` (`GROQ_MODEL`) |
| Any OpenAI-compatible API (DeepSeek, Mistral, OpenRouter, Together, Ollama…) | `OPENAI_COMPATIBLE_BASE_URL` + `OPENAI_COMPATIBLE_MODEL` (+ optional `OPENAI_COMPATIBLE_API_KEY`) | — |

- **Which one is used:** `AI_PROVIDER` if set. Otherwise Gemini if its key is present, otherwise the first configured
  provider in the order above.
- **Fallback:** if the chosen provider fails, the other configured providers are tried in order. Turn this off with `AI_FALLBACK=false`.
- **Throughput:** `AI_CONCURRENCY` (default 3) CVs are analyzed in parallel, and companies take turns so one big
  re-score can't starve the others.
- **Daily cap:** `AI_DAILY_LIMIT` (default 500) AI analyses per company per UTC day, with re-scores included; `0` means
  unlimited. CVs over the cap wait and are picked up after the day rolls over.
- The job page shows which provider and model are ranking. With no provider configured, CVs wait in the queue
  (they don't fail) and are ranked after a key is added and the server restarts.

Each CV is analyzed in one call that returns a structured profile plus an evaluation: an overall score from 0 to 100,
skills/experience/education sub-scores, matched and missing skills, strengths, concerns and a recommendation. The
prompt tells the model to treat CV text as untrusted data (to resist prompt injection) and never to use protected
attributes such as age, gender or nationality.

## Supported CVs

PDF (text-based), Word `.docx` and legacy `.doc`, and `.txt`, up to 5 MB each. Word headers, footers, tables and
text boxes are read too, since many CV templates put contact details or a skills sidebar there. Scanned image-only PDFs can't be read; those candidates
are marked *Failed* with an explanation. Employers can bulk-upload up to 50 CVs at a time (sent in batches of 10).
An identical file uploaded twice to the same job is skipped.

CV text is extracted in a separate, memory- and time-limited Node process (`scripts/extract-cv-text.mjs`), so a
malicious file (zip bomb, pathological PDF) can't freeze or crash the server. A CV that fails processing three times
is marked *Failed* instead of being retried forever.

## Scripts

| | |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Run / build / serve |
| `pnpm test` | Vitest suite (in-memory SQLite, mocked AI) |
| `pnpm typecheck` / `pnpm lint` | TypeScript / ESLint |
| `pnpm db:generate` | Create a migration after editing `src/db/schema.ts` |
| `pnpm invite [email] [--days N]` | Print a one-time signup link (optionally locked to an email) |

## Deployment notes

- Runs as a **single Node.js process** (`pnpm build && pnpm start`, or Docker) with a persistent volume for `./data`.
  SQLite, the in-process AI queue and the in-memory rate limiter all assume one instance. Move to Postgres, a job queue
  and Redis before scaling horizontally.
- Serverless platforms are not a fit, because of the local SQLite file and uploads on disk.
- Put it behind HTTPS and a reverse proxy. Session cookies are `Secure` in production.
- Per-IP rate limits read the client IP from `X-Forwarded-For`, counting `TRUST_PROXY_HOPS` entries (default 1) from
  the right. Configure the proxy to append to it (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`)
  and to cap request bodies (e.g. `client_max_body_size 60m;`).
- Ship the `scripts/` and `drizzle/` folders with the build. CV extraction and migrations read them at runtime.
- Migrations run when the server starts, not during `next build`.

See `CLAUDE.md` for architecture and conventions, and `design-system.md` for UI rules.
