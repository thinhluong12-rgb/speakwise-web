# Speakwise — Speaking Collocations Studio

Independent speaking-collocation learning application. Repository `thinhluong12-rgb/speakwise-web`; Cloudflare Worker `speakwise-studio`; separate Supabase project `tfweuvvhzhkrmxxebqwp` in Singapore.

## Learning features

- **Daily Life** and **IELTS Speaking**, each with collapsible topic navigation
- **9 topics and 61 starter collocations** with meanings, examples and notes
- Flashcards, memory quizzes, active recall, and sentence-building in written and spoken modes
- Optional Gemini feedback (requires a Cloudflare `GEMINI_API_KEY` secret)
- Optional Supabase email sign-in and cross-device study progress sync
- JSON import/export for collocations and speaking-session reviews

## Files

- `public/index.html`: website
- `public/config.js`: **public** Supabase URL and publishable key (NOT a service_role key)
- `public/sync.js`: optional secure user-data sync
- `ai-worker.js`: Cloudflare Worker; handles `/health`, `/evaluate` and static assets
- `wrangler.toml`: Worker and assets configuration
- `supabase/migrations/`: initial database schema and dataset **as documentation**. This migration has already been applied to the Speakwise Supabase project; **do not rerun** on the existing database.

## Deployment

Connect this **repository**, not `lingoquest-worker`, to the existing Cloudflare Worker application `speakwise-studio`.

- Production branch: `main`
- Root directory: repository root (not `public`)
- Build command: none, unless Cloudflare prompts you to install tools
- Deploy command: `npx wrangler deploy`
- Cloudflare Workers URL: `https://speakwise-studio.thinhluong12.workers.dev` (verify deployment in dashboard)

If using your terminal: `npm install`, `npx wrangler login`, `npx wrangler deploy`.

**Never commit secret API keys.** Set `GEMINI_API_KEY` in Worker Settings > Variables and Secrets. The site runs without AI but evaluation will report an unavailable status until the secret is set. Once the public URL works, configure it as an allowed URL in Supabase Authentication > URL Configuration.

## Git strategy

- `main`: stable/proposed production source
- `develop`: development branch for new features

LingoQuest, its repository and its Supabase project are separate; do not deploy `lingoquest-worker` for Speakwise.

## First production build

The Cloudflare Git connection is configured for this repository's `main` branch, with root `/` and deploy command `npx wrangler deploy`. This documentation-only commit triggers the first Cloudflare build without changing app code.
