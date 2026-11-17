# Speaking Lab — Realtime Voice MVP

## Scope

This feature adds a separate Voice Mode to the existing Speaking Lab. The current Text Mode and turn-based microphone recording flow remain available and are not replaced.

## Architecture

- Browser: WebRTC peer connection, microphone capture, remote audio playback, Realtime data channel events.
- Cloudflare Worker:
  - POST /voice/session authenticates the Supabase user, requires server-controlled adult verification, calls an invoker-security database RPC to create the session, and creates a short-lived Realtime client secret.
  - POST /voice/analyze verifies session ownership, reads saved turns from Supabase, and generates an evidence-based learning report.
- Supabase:
  - speakwise_voice_sessions: one row per Voice session.
  - speakwise_voice_turns: one row per speaker turn, with sequence, timestamp, and final/interrupted status.
- OpenAI Realtime: speech-to-speech over WebRTC. The standard API key remains on the Worker; only a short-lived client secret is returned to the browser.

## Data and privacy

- Raw microphone audio is not persisted by this implementation.
- Transcript turns and the generated report are stored in the signed-in user's Supabase account.
- Both tables have RLS enabled and ownership policies for authenticated users.
- Session inserts are checked by a private database trigger. A private daily-usage ledger enforces five starts per UTC day even if a user deletes session history; clients cannot read or modify that ledger.
- The user must explicitly consent in the Voice Room before microphone access.
- The user can delete the most recently saved Voice session from the Voice Room. Deleting a session cascades to its turns.
- A broader session-history management screen is not included in this MVP.
- Session rows are created by the Worker-backed database RPC only after adult verification; the browser cannot create a billable session row before this gate.

## Access control

The Worker requires:
- SUPABASE_URL
- SUPABASE_PUBLISHABLE_KEY
- OPENAI_API_KEY (Worker secret; never commit it or expose it to the browser)
- An authenticated Supabase access token
- user.app_metadata.adult_verified === true

The adult-verification flag must be set only by a legitimate, server-controlled verification process. Do not use editable user_metadata for authorization. No self-service age override is implemented.

The intended product audience is adults. If the product is ever opened to minors, reassess applicable child-safety, privacy, data-retention, moderation, and age-assurance requirements before enabling it.

## Current limits

- Maximum 5 session starts per UTC day, enforced by a per-user PostgreSQL advisory transaction lock and a private usage ledger. This is an application usage cap, not a provider billing hard stop; provider-side spend limits are still required.
- Frontend automatically ends a session after 20 minutes. This is a client-side guard, not a hard server-side duration guarantee.
- Transcript analysis does not provide an official IELTS band score.
- Pronunciation is explicitly marked not_assessed; transcript text alone is insufficient to assess pronunciation.

## Worker configuration

wrangler.toml contains non-secret Supabase and model settings. The Realtime API key must be stored as a Worker secret by the responsible adult account owner. Do not add API keys to GitHub, public/config.js, or any browser bundle.

## Manual acceptance checklist

1. Sign in with a legitimately adult-verified account.
2. Open Speaking Lab and switch to Voice.
3. Confirm consent is required before microphone access.
4. Start a session and verify remote Coach AI audio.
5. Speak, pause, and verify user and Coach AI transcript turns appear separately.
6. Interrupt Coach AI using both natural barge-in and the interrupt button.
7. Mute/unmute the microphone.
8. End the session and verify the transcript and report are saved.
9. Verify Pronunciation is labelled not assessed.
10. Delete the saved session and verify its turns are cascade-deleted.
11. Verify Text Mode still works unchanged.
12. Verify a non-verified account receives HTTP 403 and an unauthenticated account receives HTTP 401.
13. Verify the sixth daily session attempt is rejected, including concurrent requests; retain provider-side spend limits because the application quota is not a hard billing control.
14. Verify a user without the server-controlled adult flag cannot create a session row through the RPC or receive a Realtime client secret.
15. Verify every report evidence quote and correction source phrase exists in the saved learner transcript; unsupported quotes must be removed.

## Automated checks

The `Speaking Lab Voice checks` GitHub Actions workflow runs JavaScript syntax validation and static contract tests for the adult-verification gate, serialized database session creation, private quota ledger, browser API-key isolation, transcript evidence validation, and transcript-only pronunciation limitation. These checks do not replace browser-based end-to-end testing with a real provider session.

## Deployment boundary

This branch is not a production deployment. Cloudflare deployment and the provider secret are intentionally not performed here because no Cloudflare management action is available in the connected tools. The code must be deployed to a staging environment and tested with an adult-managed provider account before any production rollout.