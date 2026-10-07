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

1. Sign up with your company name (and website, which is shown to applicants so they know the role is genuine).
2. Create a job: the description, requirements and key skills are what the AI ranks against.
3. Share the **Apply link** from the job page, or use **Upload CVs** for CVs you already have.
4. Candidates appear ranked within a minute. Open one to see the extracted profile and the reasoning behind the score.
5. Select candidates and export them as CSV, Excel or a ZIP of CVs.

The SQLite database and uploaded CVs live in `./data/` (git-ignored). Migrations run automatically.

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
- **Throughput:** `AI_CONCURRENCY` (default 3) CVs are analyzed in parallel.
- The job page shows which provider and model are ranking, and warns when none is configured. CVs wait in the
  queue until a key is added, and are picked up again on restart.

Each CV is analyzed in one call that returns a structured profile plus an evaluation: an overall score from 0 to 100,
skills/experience/education sub-scores, matched and missing skills, strengths, concerns and a recommendation. The
prompt tells the model to treat CV text as untrusted data (to resist prompt injection) and never to use protected
attributes such as age, gender or nationality.

## Supported CVs

PDF (text-based), Word `.docx` and `.txt`, up to 5 MB each. Scanned image-only PDFs can't be read; those candidates
are marked *Failed* with an explanation. Employers can bulk-upload up to 50 CVs at a time.

## Scripts

| | |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Run / build / serve |
| `pnpm test` | Vitest suite (in-memory SQLite, mocked AI) |
| `pnpm typecheck` / `pnpm lint` | TypeScript / ESLint |
| `pnpm db:generate` | Create a migration after editing `src/db/schema.ts` |

## Deployment notes

- Runs as a **single Node.js process** (`pnpm build && pnpm start`, or Docker) with a persistent volume for `./data`.
  SQLite, the in-process AI queue and the in-memory rate limiter all assume one instance. Move to Postgres, a job queue
  and Redis before scaling horizontally.
- Serverless platforms are not a fit, because of the local SQLite file and uploads on disk.
- Put it behind HTTPS. Session cookies are `Secure` in production.

See `CLAUDE.md` for architecture and conventions, and `design-system.md` for UI rules.
