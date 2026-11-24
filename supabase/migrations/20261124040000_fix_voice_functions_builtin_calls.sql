-- Fix runtime errors in the Voice Mode database functions.
-- `coalesce` and `trim` are SQL syntax, not schema-qualified functions, so calls such as
-- pg_catalog.coalesce(...) and pg_catalog.trim(...) fail at runtime with "function ... does not exist".
-- This rewrites the existing definitions in place and keeps every other attribute unchanged.
-- Applied to production on 2026-11-24; safe to run again.
do $$
declare
  r record;
  d text;
begin
  for r in
    select p.oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prokind = 'f'
      and ((n.nspname = 'public' and p.proname = 'start_speakwise_voice_session')
        or (n.nspname = 'private' and p.proname = 'enforce_speakwise_voice_daily_quota'))
  loop
    d := pg_get_functiondef(r.oid);
    d := replace(d, 'pg_catalog.coalesce(', 'coalesce(');
    d := replace(d, 'pg_catalog.trim(', 'pg_catalog.btrim(');
    execute d;
  end loop;
end $$;
