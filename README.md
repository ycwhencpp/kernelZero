# SignalCast

SignalCast is a personal research-intelligence and podcast studio. It discovers papers from OpenAlex, Semantic Scholar, and arXiv; reads approved RSS/Atom feeds; builds a searchable library; produces evidence-grounded podcast drafts; and exposes approved audio through a podcast RSS feed.

## What works

- Five product workspaces: Discover, Daily Inbox, Library, Podcast Studio, and Tech Radar.
- Durable Supabase Postgres data for interests, sources, content, collections, episodes, evidence, feedback, and job history.
- Supabase Storage for generated MP3 files.
- Live paper search across OpenAlex, Semantic Scholar, and arXiv.
- User-approved RSS/Atom source verification and ingestion.
- DOI/arXiv/URL/title deduplication and relevance/freshness/authority ranking.
- Daily digest and paper/blog deep-dive generation.
- Structured claim ledger plus a separate evidence-verification pass.
- OpenAI Responses API, Gemini, and a local Ollama/macOS speech path.
- Consent-backed local Chatterbox narrator voices: Ollama can write the script while Chatterbox narrates with the selected local reference voice.
- Review-before-publish approval.
- Public `/feed.xml`, transcript routes, immutable episode GUIDs, and podcast artwork.
- Signed daily scheduler endpoint with idempotent job history.

## Local setup

```bash
cp .env.example .env.local
npm install
npm run dev
```

Create a Supabase project, run every migration in `supabase/migrations/` in its SQL
editor (currently `0001_initial.sql` through `0004_workspace_settings_and_multiple_voices.sql`), and add `NEXT_PUBLIC_SUPABASE_URL` plus the server-only
`SUPABASE_SERVICE_ROLE_KEY` to `.env.local`. The migration creates the required
`podcast-media` public Storage bucket.

Install Ollama plus FFmpeg, pull a model such as `qwen2.5:14b`, and set `AI_PROVIDER=ollama` (or leave `AI_PROVIDER=auto`; it falls back to Ollama when cloud keys are absent). SignalCast uses the local model for structured writing and verification, then macOS speech synthesis for MP3 audio when no custom local voice is configured. Provider calls are server-only; no static demo records are inserted into the database.

## Local Chatterbox narrator voice

Chatterbox gives the app a fully local custom narrator voice; it does not need an OpenAI key. Install it once with Python 3.11:

```bash
python3.11 -m venv .venv-chatterbox
.venv-chatterbox/bin/python -m pip install -r requirements/chatterbox.txt
```

In **Settings → AI Voice & Persona**, upload one clear 6–30 second sample for each speaker you own or have explicit permission to use. Select the active narrator from the Primary Narrator picker and use its preview button before generating an episode. SignalCast retains the raw reference clips only in `.signalcast/voices` on the local host; Supabase receives opaque file keys rather than audio. The Chatterbox model weights download into the local Hugging Face cache on first narration (or `CHATTERBOX_CACHE_DIR` if set), then are reused locally. Remove a profile to delete its reference clip.

Episode length, daily generation, and publish time are persisted in Supabase. The chosen length is passed to both manual generation and the daily cron, so it controls the next script rather than only the settings UI.

Production variables:

- `GEMINI_API_KEY` or `OPENAI_API_KEY` (one is enough; optional `AI_PROVIDER=gemini|openai|ollama|auto`)
- `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_CONTEXT_SIZE`, `LOCAL_TTS_VOICE`, `LOCAL_TTS_RATE` (optional local Ollama/macOS speech settings)
- `CHATTERBOX_PYTHON`, `CHATTERBOX_DEVICE`, `CHATTERBOX_CACHE_DIR`, `LOCAL_VOICE_STORAGE_DIR` (optional local Chatterbox settings)
- `REQUIRE_LOCAL_VOICE=true` to prevent a cron or manual generation from silently falling back to the system voice when no local narrator is configured
- `GEMINI_TEXT_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE` (optional Gemini overrides)
- `OPENAI_API_KEY` and OpenAI model overrides (if using OpenAI)
- `PODCAST_BASE_URL`
- `PODCAST_EMAIL` (use a dedicated public creator address)
- `CRON_SECRET`
- `CRON_OWNER_EMAIL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only; never expose this in the browser)
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

Unit tests cover canonical identities, deduplication, ranking, source diversity, RSS parsing, speech chunking, and XML escaping.
