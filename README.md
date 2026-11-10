# Scrub

Frame-accurate video review for an editor and their clients. Clients open a link, type their name, comment on exact frames, and **request cuts** — then watch the video with those cuts skipped before the editor touches anything.

Specs: Technical Risks, Cut Requests Feature Spec and PRD (Claude Docs, linked from the PRD).

## Run it locally

Requirements: Node 24, Docker via OrbStack, ffmpeg (only for test videos).

```bash
npm install
docker compose up -d        # local S3-compatible storage (RustFS) standing in for Cloudflare R2
npm run storage:init        # creates the bucket and its CORS rules
npm run dev                 # http://localhost:3000
```

`.env.local` holds the Supabase project URL and publishable key, plus storage settings. It is not committed.

Supabase settings this app needs (Dashboard → Authentication → Sign In / Providers):

- **Allow anonymous sign-ins: ON** — clients join share links without accounts.
- **Confirm email** — turned off for local testing; turn it back on before real use.

Database migrations live in `supabase/migrations/` and have been applied to the hosted project.

## Tests

```bash
npm test                          # timecode, drop-frame, cut-range maths, EDL/XML/CSV exports
npm run test:rls -- <share-token> # permission checks against the real database, as strangers and guests
```

The test videos in `test-fixtures/` (gitignored) carry a 16-block binary frame number in the top-left corner, so a browser test can read the exact frame on screen from the pixels.

## How it fits together

| Piece | Where |
| --- | --- |
| Frame/timecode maths (rational rates, drop-frame) | `src/lib/timecode.ts` |
| Cut ranges, preview mapping | `src/lib/ranges.ts` |
| Resolve EDL, Premiere XML, CSV, cut list | `src/lib/exports.ts` |
| File inspection before upload (Mediabunny) | `src/lib/client/probe.ts` |
| Resumable multipart upload, direct to storage | `src/lib/client/uploader.ts`, `src/app/api/uploads/*` |
| Signed playback URLs (2 h, refreshed) | `src/app/api/playback` |
| Frame-accurate player engine | `src/components/review/usePlayer.ts` |
| Timeline (zoom, snapping, cut lanes) | `src/components/review/Timeline.tsx` |
| Review screen | `src/components/review/Review.tsx` |
| Schema, RLS, triggers, RPCs | `supabase/migrations/` |

Route handlers act as the caller (their Supabase JWT), so row-level security decides every permission. No service-role key is used anywhere.

## Deploying (later)

1. Create a Cloudflare R2 bucket and an API token scoped to it.
2. Set on Vercel: the two `NEXT_PUBLIC_SUPABASE_*` values, `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE=false`, `APP_ORIGIN=https://<your-domain>`.
3. Run `npm run storage:init` once with those values to set R2's CORS rules.
4. Add the production URL to Supabase Auth's allowed redirect URLs.

## Not built yet

- H.264 review copies made in the browser for H.265 uploads (clients whose computer can't decode H.265 currently see a clear message instead).
- Approvals, email digests, next-version cut-request checklist and "From v1" panel.
- Two-video seamless preview engine (the current one seeks at each cut; tested at zero leaked frames).
- Share-link passphrases and expiry, Turnstile bot check on guest sign-in.
