<img src="public/brand/icon-512.png" width="64" height="64" alt="Shortlist logo">

# Shortlist — CV collection & AI ranking

Create a job, share its link, and let applicants upload their CV, or upload CVs you already have.
Every CV is turned into a structured candidate profile and ranked against the job by AI. Review the
ranked list, shortlist the people you want, and export them as **CSV**, **Excel** or a **ZIP of their CVs**.

Runs on **Netlify** using free tiers only; the AI provider is the one paid part:

| Need | Service (free plan) | Local development |
|---|---|---|
| App hosting | Netlify | `pnpm dev` |
| Database | Neon Postgres | Embedded Postgres (PGlite) in `./data/pglite`; no setup needed |
| CV files | Netlify Blobs (automatic on Netlify) | Local disk, `./data/uploads` |
| Background AI ranking, hourly retention | Inngest | In-process queue |

## Quick start (local)

```bash
pnpm install
cp .env.example .env.local      # add an AI key (GEMINI_API_KEY is the default) and ADMIN_EMAIL / ADMIN_PASSWORD
pnpm dev                        # http://localhost:3000
```

Leave `DATABASE_URL` empty locally to use the embedded database, which needs no setup. To develop against Neon
instead, point `DATABASE_URL` at a database **dedicated to Shortlist** and run `pnpm db:migrate` once. The migrate
command refuses to touch a database that already holds another app's tables.

1. **First admin:** with `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12+ characters) set, the platform admin account is created
   when the server starts. Log in at `/login`.
2. Signups are **invite-only**. As the admin, open **Invites** in the dashboard to create a one-time signup link for each
   company (optionally locked to their email), or run `pnpm invite [email] [--days 14]`. Companies sign up with their
   name and website, which is shown to applicants so they know the role is genuine.
3. Create a job: the description, requirements and key skills are what the AI ranks against.
4. Share the **Apply link** from the job page, or use **Upload CVs** for CVs you already have.
5. Candidates appear ranked within a minute. Open one to see the extracted profile and the reasoning behind the score.
6. Select candidates and export them as CSV, Excel or a ZIP of CVs (the ZIP is assembled in your browser).

## Deploy to Netlify (all free tiers)

1. **Neon:** create a free project at [neon.com](https://neon.com) and copy the **pooled** connection string.
2. **Inngest:** create a free account at [inngest.com](https://www.inngest.com), create an app, and copy its
   **Event key** and **Signing key**.
3. **Netlify:** import the repository. The build settings come from `netlify.toml`. Production deploys run
   `pnpm db:migrate && pnpm build`, so the database is migrated before each deploy goes live. Deploy previews and
   branch deploys only build; they never migrate. Under *Site configuration → Environment variables* set the following,
   **scoped to the Production context** so a pull-request preview can never read or write production data (for
   previews, use a separate Neon branch's URL, or leave them unset):
   - `DATABASE_URL` (Neon), `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`
   - at least one AI key, e.g. `GEMINI_API_KEY`
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `APP_URL` (your site URL)
   - `STORAGE_DRIVER=netlify-blobs` (detected automatically, but set it explicitly to be safe)
   - never set `INNGEST_DEV` in production (it disables signature checks; the app refuses to run jobs with it)
4. Deploy. Then, in Inngest, **sync** the app with `https://<your-site>/api/inngest`. This registers the CV-ranking,
   requeue and hourly retention functions.
5. Log in with the admin account and create invites.

CV files go to Netlify Blobs automatically; there's nothing to configure.

### Limits to know

- **CVs are capped at 4 MB.** Netlify functions accept about 4.5 MB of binary upload per request. Employer bulk uploads
  send one CV per request.
- Every request, and every background step, must finish within Netlify's 60-second function limit. Each AI provider
  call has a 45-second timeout, and if one provider fails the next configured provider is tried.
- Free-tier headroom: Inngest gives 50,000 executions a month (about 12,000 CVs, since each CV takes several steps),
  and Neon gives 1 GB of storage. Data retention keeps the database small.

## Data retention

Each company picks a retention period in **Settings** (Off / 30 / 90 / 180 days; default 90). Once a job has been
closed that long, every candidate on it is permanently deleted: the CV file plus the extracted text, profile and AI
evaluation. The job post itself stays. Reopening a job stops the clock. The purge runs hourly (as an Inngest cron on
Netlify, or in-process locally). Employers can also delete candidates one at a time, in bulk, or by deleting the job.
Closed jobs accept no new CVs, either from the public link or from employer uploads.

## AI providers

Configured entirely by environment variables. Set one or more keys:

| Provider | Key | Default model (override) |
|---|---|---|
| Google Gemini (**default**) | `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` | `gemini-3.8-flash,gemini-3.5-flash-lite` (`GEMINI_MODEL`) |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.4-mini` (`OPENAI_MODEL`) |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` (`ANTHROPIC_MODEL`) |
| Groq | `GROQ_API_KEY` | `openai/gpt-oss-120b` (`GROQ_MODEL`) |
| Any OpenAI-compatible API (DeepSeek, Mistral, OpenRouter, Together, Ollama…) | `OPENAI_COMPATIBLE_BASE_URL` + `OPENAI_COMPATIBLE_MODEL` (+ optional `OPENAI_COMPATIBLE_API_KEY`) | — |

- **Which one is used:** `AI_PROVIDER` if set. Otherwise Gemini if its key is present, otherwise the first configured
  provider in the order above.
- **Fallback:** every `*_MODEL` variable accepts a comma-separated list (e.g. `GEMINI_MODEL=gemini-3.8-flash,gemini-3.5-flash-lite`).
  The chosen provider's models are tried in order, then the other configured providers'. `AI_FALLBACK=false` keeps
  only the first model.
- **Busy models:** when every model is temporarily overloaded (HTTP 429/503 "high demand"), the CV isn't failed. It goes
  back to the queue marked *Retrying*, its daily-cap charge is refunded, and it's retried automatically (about every
  5 minutes locally, 30 minutes on Netlify). It's marked *Failed* on the 12th busy try.
- **Fairness:** companies take turns, so one company's big re-score can't starve the others.
- **Daily cap:** `AI_DAILY_LIMIT` (default 500) AI analyses per company per UTC day, with re-scores included; `0` means
  unlimited. CVs over the cap wait and are picked up after the day rolls over.
- With no provider configured, CVs wait (they don't fail) and are ranked once a key is added.

Each CV is analyzed in one call that returns a structured profile plus an evaluation: an overall score from 0 to 100,
skills/experience/education sub-scores, matched and missing skills, strengths, concerns and a recommendation. The
prompt tells the model to treat CV text as untrusted data (to resist prompt injection) and never to use protected
attributes such as age, gender or nationality.

## Supported CVs

PDF (text-based), Word `.docx` and legacy `.doc`, and `.txt`, up to 4 MB each. Word headers, footers, tables and text
boxes are read too, since many CV templates put contact details or a skills sidebar there. Scanned image-only PDFs
can't be read; those candidates are marked *Failed* with an explanation. An identical file uploaded twice to the same
job is skipped.

Malicious files (zip bombs, pathological PDFs) can't take the app down. On Netlify, each CV is parsed in its own
short-lived function invocation with size and time caps. Locally, parsing runs in a memory- and time-limited child
process. A CV that fails processing three times is marked *Failed* instead of being retried forever.

## Scripts

| | |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Run / build / serve |
| `pnpm test` | Vitest suite (in-memory Postgres via PGlite, mocked AI) |
| `pnpm typecheck` / `pnpm lint` | TypeScript / ESLint (type-aware: catches un-awaited database calls) |
| `pnpm db:generate` | Create a migration after editing `src/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` (runs automatically in the Netlify build) |
| `pnpm invite [email] [--days N]` | Print a one-time signup link (optionally locked to an email) |

See `CLAUDE.md` for architecture and conventions, and `design-system.md` for UI rules.

## License

[MIT](LICENSE) © 2026 Samson Oluwafemi
