# Speakwise v4.4 — Personal Speaking Collocation Coach

## What's new
- Today's Focus prioritises overdue, weak and new collocations; daily goal counts distinct entries with study activity.
- Learn → Recall → Apply → Review journey; optional skip, distraction-free Focus Mode, save/exit/resume.
- Evidence-based stages: New, Recognised, Recalled, Applied. Applied requires a successful typed recall and high AI-assisted usage feedback on two different local dates, not merely repeated flashcard flips.
- My Mistakes saves corrected sentences only when the learner chooses to save feedback. Retry prompts a new sentence.
- Topic Mastery summary, mobile bottom navigation, compact dashboard.
- Supabase sync for progress evidence, mistakes and learning preferences; local-first fallback.

## Privacy
Gemini API key remains a Cloudflare Worker Secret. Raw recording audio is not stored in Supabase as a mistake. If signed in, manually saved text and revision notes sync to private RLS-protected rows.

## Schema
The two migrations in supabase/migrations dated 20261117 have already been applied to the separate Speakwise project. Do not manually rerun in production.
Existing SRS levels remain; new mastery stages require new evidence and are not retroactively inferred from old review counts.

## Manual QA
- Start Today's Practice: Learn, correct/incorrect Recall, AI Write/Speak, Review.
- Save a My Mistakes entry; mark resolved; use Try Again.
- Leave Journey midway; resume from Home.
- Check Focus Mode, mobile navigation, daily goal selector and topic progress.
- Sign in and verify sync on a second device. No sign-in should keep local data.
- AI scoring is guidance only; ensure no 404/timeout errors before claiming live Gemini validation.