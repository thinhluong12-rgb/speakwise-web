-- Speakwise: daily goal and resumable learning journey
CREATE TABLE IF NOT EXISTS public.speakwise_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.speakwise_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sw_prefs_select ON public.speakwise_preferences;
DROP POLICY IF EXISTS sw_prefs_insert ON public.speakwise_preferences;
DROP POLICY IF EXISTS sw_prefs_update ON public.speakwise_preferences;
CREATE POLICY sw_prefs_select ON public.speakwise_preferences FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));
CREATE POLICY sw_prefs_insert ON public.speakwise_preferences FOR INSERT TO authenticated WITH CHECK (user_id=(SELECT auth.uid()));
CREATE POLICY sw_prefs_update ON public.speakwise_preferences FOR UPDATE TO authenticated USING (user_id=(SELECT auth.uid())) WITH CHECK (user_id=(SELECT auth.uid()));
GRANT SELECT,INSERT,UPDATE ON public.speakwise_preferences TO authenticated;