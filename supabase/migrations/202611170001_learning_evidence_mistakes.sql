-- Speakwise: evidence-based learning and learner-reviewed AI mistakes
ALTER TABLE public.speakwise_progress
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_reviewed date;
CREATE TABLE IF NOT EXISTS public.speakwise_mistakes (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_id text REFERENCES public.speakwise_entries(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('write','speak')),
  original_text text NOT NULL,
  suggested_revision text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sw_mistakes_owner_status_idx ON public.speakwise_mistakes (user_id,status,created_at DESC);
ALTER TABLE public.speakwise_mistakes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sw_mistakes_select ON public.speakwise_mistakes;
DROP POLICY IF EXISTS sw_mistakes_insert ON public.speakwise_mistakes;
DROP POLICY IF EXISTS sw_mistakes_update ON public.speakwise_mistakes;
DROP POLICY IF EXISTS sw_mistakes_delete ON public.speakwise_mistakes;
CREATE POLICY sw_mistakes_select ON public.speakwise_mistakes FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));
CREATE POLICY sw_mistakes_insert ON public.speakwise_mistakes FOR INSERT TO authenticated WITH CHECK (user_id=(SELECT auth.uid()));
CREATE POLICY sw_mistakes_update ON public.speakwise_mistakes FOR UPDATE TO authenticated USING (user_id=(SELECT auth.uid())) WITH CHECK (user_id=(SELECT auth.uid()));
CREATE POLICY sw_mistakes_delete ON public.speakwise_mistakes FOR DELETE TO authenticated USING (user_id=(SELECT auth.uid()));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.speakwise_mistakes TO authenticated;