# KernelZero

KernelZero is a personal research-intelligence and podcast studio. It discovers papers from OpenAlex, Semantic Scholar, and arXiv; reads approved RSS/Atom feeds; builds a searchable library; produces evidence-grounded podcast drafts; and exposes approved audio through a podcast RSS feed.

## What works

- Five product workspaces: Discover, Daily Inbox, Library, Podcast Studio, and Tech Radar.
- Durable Supabase Postgres data for interests, sources, content, collections, episodes, evidence, feedback, and job history.
- Private Supabase Storage for generated audio and validated profile pictures.
- Live paper search across OpenAlex, Semantic Scholar, and arXiv.
- User-approved RSS/Atom source verification and ingestion.
- DOI/arXiv/URL/title deduplication and relevance/freshness/authority ranking.
- Daily digest and paper/blog deep-dive generation.
- Structured claim ledger with explicit source ownership and evidence review.
- OpenAI Responses API, Gemini, and a local Ollama/macOS speech path.
- Consent-backed local Chatterbox narrator voices: Ollama can write the script while Chatterbox narrates with the selected local reference voice.
- Supabase email/password login with an isolated workspace for every account.
- Review-before-publish approval restricted to each workspace owner, including durable title-alignment warnings and an explicit owner override.
- An authenticated Explore directory for published podcasts and creator profiles.
- Public `/feed.xml`, transcript routes, immutable episode GUIDs, and podcast artwork.
- Signed daily scheduler endpoint with idempotent job history.

## Local setup

```bash
cp .env.example .env.local
npm install
npm run dev
```

Create a Supabase project and run every migration in `supabase/migrations/`
(currently `0001_initial.sql` through `0010_episode_generation_warning.sql`). Enable the
Email provider in **Authentication → Providers**, then add
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and the
server-only `SUPABASE_SERVICE_ROLE_KEY` to `.env.local`. Older Supabase projects
can use `NEXT_PUBLIC_SUPABASE_ANON_KEY` in place of the publishable key. The
migrations create the required private `podcast-media` bucket, authenticated
workspace-scoped RLS policies, and per-user ownership constraints. Published
audio is streamed through the application media route.

For an existing deployment, apply `0008_user_workspace_isolation.sql` before
deploying this application version. It changes deterministic workspace keys to
owner-scoped keys, makes podcast media private, and adds the published-directory
index and citation count used by Explore.

Every verified account owns a separate workspace. Sources, interests, drafts,
settings, voices, and production history are scoped to that account. Published
audio can appear in the authenticated Explore directory, but private workspace
records are never loaded from another account. Profile pictures are uploaded as
validated JPEG, PNG, or WebP files and served through short-lived signed URLs;
arbitrary remote image URLs are not accepted.

Install Ollama plus FFmpeg, pull `redbus-gemma:latest`,
`mistral:7b-instruct`, `nomic-embed-text`, and
`gpt-oss-safeguard:20b`, then set `AI_PROVIDER=ollama` (or leave
`AI_PROVIDER=auto`; it falls back to Ollama when cloud keys are absent). macOS
speech synthesis produces MP3 audio when no custom local voice is configured.
Provider calls and source extraction are server-only.

The Ollama path is source-aware and sequential. It hydrates only the selected
one to five sources into an owner-scoped plain-text block cache, plans four or
five semantic segments without a title, writes each segment with a compact
rolling digest, flags semantic duplicates with one batched embedding request,
consolidates with Redbus, audits with safeguard, and generates title/dek with
Mistral only after the transcript is immutable. OpenAI and Gemini retain their
existing generation paths. Planning, writer, consolidation, and review evidence
packets have strict serialized-size budgets and retain provenance-tagged
first/middle/last excerpts from oversized blocks. Claim provenance uses assigned
block IDs with server-derived global source numbers; an invalid model response
retries only the affected stage rather than restarting or failing the episode.

HTML extraction uses Readability; open-access PDFs use `unpdf`. Downloads are
DNS-pinned, redirect-checked, MIME-checked, time-bounded, and streamed under the
limits in `.env.example`. Feed-only sources use captured RSS/Atom bodies and
never crawl linked pages. For a host with enough RAM or VRAM, start Ollama with:

```bash
OLLAMA_NUM_PARALLEL=3 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KEEP_ALIVE=30m ollama serve
```

The new writers are intentionally sequential; document downloads remain bounded
to two at a time and PDF parsing to one at a time. Verify model placement and
allocated context with `ollama ps`. `OLLAMA_PIPELINE_LOG_LEVEL=info|debug|off`
controls metadata-only structured stage logs; source text, transcript text,
digests, and titles are never logged.

## Local Chatterbox narrator voice

Chatterbox gives the app a fully local custom narrator voice; it does not need an OpenAI key. Install it once with Python 3.11:

```bash
python3.11 -m venv .venv-chatterbox
.venv-chatterbox/bin/python -m pip install -r requirements/chatterbox.txt
```

In **Settings → AI Voice & Persona**, upload one clear 6–30 second sample for each speaker you own or have explicit permission to use. Select the active narrator from the Primary Narrator picker and use its preview button before generating an episode. KernelZero retains the raw reference clips only in `.kernelzero/voices` on the local host; Supabase receives opaque file keys rather than audio. The Chatterbox model weights download into the local Hugging Face cache on first narration (or `CHATTERBOX_CACHE_DIR` if set), then are reused locally. Remove a profile to delete its reference clip.

Episode length, daily generation, and publish time are persisted in Supabase. The chosen length is passed to both manual generation and the daily cron, so it controls the next script rather than only the settings UI.

Production variables:

- `GEMINI_API_KEY` or `OPENAI_API_KEY` (one is enough; optional `AI_PROVIDER=gemini|openai|ollama|auto`)
- `OLLAMA_BASE_URL`, `OLLAMA_SCRIPT_MODEL`, `OLLAMA_CONSOLIDATION_MODEL`, `OLLAMA_REVIEW_MODEL`, `OLLAMA_METADATA_MODEL`, `OLLAMA_EMBEDDING_MODEL`, `OLLAMA_DIGEST_AUDIT_MODE`, `OLLAMA_DEDUP_SIMILARITY_THRESHOLD`, `OLLAMA_PLANNING_SOURCE_MAX_CHARACTERS`, `OLLAMA_SEGMENT_SOURCE_MAX_CHARACTERS`, `OLLAMA_REVIEW_SOURCE_MAX_CHARACTERS`, `OLLAMA_SEMANTIC_BLOCK_MAX_CHARACTERS`, and role-specific context/output/keep-alive settings (local semantic pipeline)
- `SOURCE_DOCUMENT_FETCH_TIMEOUT_MS`, `SOURCE_DOCUMENT_BATCH_TIMEOUT_MS`, `SOURCE_DOCUMENT_HTML_MAX_BYTES`, `SOURCE_DOCUMENT_PDF_MAX_BYTES`, `SOURCE_DOCUMENT_MAX_CHARACTERS`, `SOURCE_DOCUMENT_MAX_BLOCKS`, and `SOURCE_DOCUMENT_MAX_PDF_PAGES` (selected-source hydration limits)
- `CHATTERBOX_PYTHON`, `CHATTERBOX_DEVICE`, `CHATTERBOX_CACHE_DIR`, `CHATTERBOX_MAX_TEMPO_ADJUSTMENT`, `CHATTERBOX_MIN_WPM`, `CHATTERBOX_MAX_WPM`, `LOCAL_VOICE_STORAGE_DIR` (optional local Chatterbox settings; out-of-range chunks are retried, then the fastest clear candidate inside a bounded slow-rate tolerance may be retained; fast chunks still fail)
- `REQUIRE_LOCAL_VOICE=true` to prevent a cron or manual generation from silently falling back to the system voice when no local narrator is configured
- `GEMINI_TEXT_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE` (optional Gemini overrides)
- `OPENAI_API_KEY` and OpenAI model overrides (if using OpenAI)
- `PODCAST_BASE_URL`
- `PODCAST_EMAIL` (use a dedicated public creator address)
- `CRON_SECRET`
- `CRON_OWNER_EMAIL` (the verified account must sign in once before the cron runs)
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`)
- `SUPABASE_SERVICE_ROLE_KEY` (server-only; never expose this in the browser)
- `REQUIRE_AUTH=true`
- Optional model, voice, title, description, budget, and authentication overrides listed in `.env.example`

## Daily automation (Vercel)

`vercel.json` schedules `/api/cron/daily` once daily at midnight UTC (05:30
Asia/Kolkata). Vercel sends `Authorization: Bearer <CRON_SECRET>` automatically
when `CRON_SECRET` is configured in the Vercel project. The handler also accepts
POST for a manual scheduler.

The endpoint:

1. Fetches each enabled interest from all academic adapters.
2. Normalizes, scores, and deduplicates results.
3. Selects a source-diverse digest.
4. Generates and verifies the script.
5. Generates and stores audio using the selected local Chatterbox voice (or the configured default TTS) when Supabase Storage is available.
6. Creates an episode in `needs_approval`.
7. Treats the date-based job key as idempotent.

## Spotify

1. Configure a stable HTTPS `PODCAST_BASE_URL` and dedicated `PODCAST_EMAIL`.
2. Generate audio and approve an episode so `/feed.xml` contains a playable enclosure.
3. Validate the feed with a podcast-feed validator.
4. In Spotify for Creators, add an existing show using the public `/feed.xml` URL.
5. Complete the email verification once. New approved episodes with audio then flow through the same feed.

## Verification

```bash
npm run test:unit
npx tsc --noEmit
npm run lint
npm test
```

Unit tests cover canonical identities, semantic planning and deduplication,
claim provenance, title warnings, dynamic chapters, structured HTML/PDF/feed
extraction, SSRF/redirect/size/timeout defenses, ranking, speech chunking, and XML
escaping.

For local similarity calibration without transcript text in normal server logs:

```bash
npm run calibrate:dedup -- /path/to/transcript.txt 0.85
```

Add `--show-text` only when you explicitly want sentence text printed in that
local terminal.
