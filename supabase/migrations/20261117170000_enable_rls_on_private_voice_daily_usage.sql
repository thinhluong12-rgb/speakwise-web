-- Keep per-user voice quota accounting inaccessible to API roles.
-- The SECURITY DEFINER trigger function is owned by postgres and remains able
-- to maintain this private table; no client-facing policies are required.
ALTER TABLE private.speakwise_voice_daily_usage ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.speakwise_voice_daily_usage FROM PUBLIC, anon, authenticated, service_role;
