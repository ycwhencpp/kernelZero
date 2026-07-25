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
- OpenAI Responses API and `tts-1-hd` adapters with a complete no-key demo fallback.
- Review-before-publish approval.
- Public `/feed.xml`, transcript routes, immutable episode GUIDs, and podcast artwork.
- Signed daily scheduler endpoint with idempotent job history.

## Local setup

```bash
cp .env.example .env.local
npm install
npm run dev
```

Create a Supabase project, run `supabase/migrations/0001_initial.sql` in its SQL
editor, and add `NEXT_PUBLIC_SUPABASE_URL` plus the server-only
`SUPABASE_SERVICE_ROLE_KEY` to `.env.local`. The migration creates the required
`podcast-media` public Storage bucket.

The complete demo works without external credentials. Add `GEMINI_API_KEY` or `OPENAI_API_KEY` to generate full scripts and MP3/WAV audio. With `AI_PROVIDER=auto` (default), Gemini is used when `GEMINI_API_KEY` is set. Provider calls are server-only.

Production variables:

- `GEMINI_API_KEY` or `OPENAI_API_KEY` (one is enough; optional `AI_PROVIDER=gemini|openai|auto`)
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
5. Generates and stores audio when an OpenAI key and Supabase Storage are available.
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
