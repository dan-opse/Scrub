# Scrub

Frame-accurate video review for an editor and their clients. Clients open a link, type their name, comment on exact frames, and **request cuts** — then watch the video with those cuts skipped before the editor touches anything. When the editor uploads the next version, the earlier requests are ticked off and the client can see what was done, then approve.

Specs: Technical Risks, Cut Requests Feature Spec and PRD (Claude Docs, linked from the PRD).

## Run it locally

Requirements: Node 24, Docker via OrbStack, ffmpeg (only for generating test videos).

```bash
npm install
docker compose up -d        # local S3-compatible storage (RustFS) standing in for Cloudflare R2
npm run storage:init        # creates the bucket and its CORS rules
npm run dev                 # http://localhost:3000
```

`.env.local` holds the Supabase project URL and publishable key, storage settings, and the optional `STORAGE_ALLOWANCE_GB` (default 10). It is not committed.

Supabase settings this app needs (Dashboard → Authentication → Sign In / Providers):

- **Allow anonymous sign-ins: ON** — clients join share links without accounts.
- **Confirm email** — turned off for local testing; turn it back on before real use.

Database migrations live in `supabase/migrations/` and have been applied to the hosted project.

## What it does

| Area | Details |
| --- | --- |
| Upload | H.264 or H.265, MP4 or MOV, up to 50 GB. The file is inspected in the browser first (codec, frame rate, frame count, start timecode from the MOV timecode track, warnings). Resumable 16 MB parts go straight to storage; drop the same file again to resume. |
| Review copies | H.265 uploads get an H.264 copy made in the editor's browser (WebCodecs, hardware encoders), checked frame-for-frame, and uploaded alongside. Viewers whose device can't decode H.265 get the copy automatically; anyone can switch with the Original / Review copy menu. A missing copy can be made later from the video page. |
| Player | Frame-accurate seeking and stepping, checked against burned-in frame numbers in tests. Timecode (drop-frame aware), clock or frames. Timeline zoom to single frames, snapping, J/K/L, I/O, `?` for all shortcuts. |
| Comments | Single-frame, range and general comments, replies, edit/delete, mark done. Live between everyone on the version. |
| Cut requests | Drag on the timeline, I/O then X, hold X during playback, or Set start / Set end buttons. Editable handles, reason, status (open, accepted, rejected with a required reply, done, withdrawn). **Preview without cuts** plays the video with the included requests skipped and shows the new runtime. Play in context / Play as cut. |
| Versions | Version stack per asset. Uploading a new version opens a checklist to mark earlier cut requests done or declined; the new version shows "From earlier versions" with each request's outcome and a "view in v1" link. |
| Approvals | Guests (if the link allows) and the editor can approve a version or request changes, with a note. Status shows in the player and the project list, with history. |
| Share links | Per link: comments on/off, downloads on/off, approval on/off, expiry date, revoke. Guests join by name; no account. |
| Export | DaVinci Resolve marker EDL (cut requests as red duration markers), Premiere Pro FCP7 XML, CSV, and a plain-text cut list. Start timecode is editable at export. |
| Management | Rename/delete projects; rename, move and delete assets; delete versions (storage objects removed). Storage meter against the allowance; uploads blocked when full. Sign out everywhere. |

## Tests

```bash
npm test                          # timecode, drop-frame, cut-range maths, exports, MOV timecode-track parser
npm run test:rls -- <share-token> # 32 permission checks against the real database, as strangers and guests
```

The test videos in `test-fixtures/` (gitignored; make them with ffmpeg) carry a 16-block binary frame number in the top-left corner, so a browser test can read the exact frame on screen from the pixels.

## How it fits together

| Piece | Where |
| --- | --- |
| Frame/timecode maths (rational rates, drop-frame) | `src/lib/timecode.ts` |
| Cut ranges, preview mapping | `src/lib/ranges.ts` |
| Resolve EDL, Premiere XML, CSV, cut list | `src/lib/exports.ts` |
| File inspection before upload (Mediabunny) | `src/lib/client/probe.ts`, `timecodeTrack.ts` |
| Review copy conversion (Web Worker + WebCodecs) | `src/lib/client/reviewCopy.worker.ts`, `reviewCopy.ts` |
| Resumable multipart upload, direct to storage | `src/lib/client/uploader.ts`, `src/app/api/uploads/*` |
| Signed playback URLs (2 h, refreshed), deletes, storage usage | `src/app/api/playback`, `api/assets`, `api/versions`, `api/storage` |
| Frame-accurate player engine | `src/components/review/usePlayer.ts` |
| Timeline (zoom, snapping, cut lanes) | `src/components/review/Timeline.tsx` |
| Review screen, approvals, version carry-over | `src/components/review/Review.tsx`, `ApprovalBar.tsx`, `VersionCarryover.tsx` |
| Schema, RLS, triggers, RPCs | `supabase/migrations/` |

Route handlers act as the caller (their Supabase JWT), so row-level security decides every permission. No service-role key is used anywhere.

## Known limits

- Clients on a computer without an H.265 decoder see a "being prepared" message until the review copy exists; the copy is made in the editor's browser, so the editor's tab has to stay open while it runs (about a third of real time on an Apple Silicon Mac).
- Preview-without-cuts seeks at each join (no leaked frames in tests, but a short freeze per join). A two-video seamless engine is a later upgrade.
- No email notifications; the project list shows open comment and cut-request counts and approval status instead.
- Share links have no passphrase and no bot check on guest sign-in (Supabase's 30-per-hour-per-IP limit applies).
- Some H.265 exports (open-GOP) can't show the frames just before a keyframe by seeking; the player plays forward to them slowly and holds the exact frame on screen (up to about a second).

## Deploying (later)

1. Create a Cloudflare R2 bucket and an API token scoped to it.
2. Set on Vercel: the two `NEXT_PUBLIC_SUPABASE_*` values, `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE=false`, `APP_ORIGIN=https://<your-domain>`, optionally `STORAGE_ALLOWANCE_GB`.
3. Run `npm run storage:init` once with those values to set R2's CORS rules.
4. Add the production URL to Supabase Auth's allowed redirect URLs.
