-- Remove the application-level Voice Mode caps (5 sessions per UTC day, 2-hour recorded duration).
-- Session length and volume are now limited only by Gemini itself (quota, per-connection limits).
-- Usage is still counted per user and UTC day for statistics. Applied to production on 2026-11-24.
create or replace function private.enforce_speakwise_voice_daily_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_claims jsonb := auth.jwt();
  v_day date := (pg_catalog.timezone('UTC', pg_catalog.now()))::date;
begin
  if v_user_id is null or new.owner_id is distinct from v_user_id then
    raise exception using errcode = '42501', message = 'VOICE_OWNER_MISMATCH';
  end if;
  if coalesce(v_claims -> 'app_metadata' ->> 'adult_verified', 'false') <> 'true' then
    raise exception using errcode = '42501', message = 'ADULT_VERIFICATION_REQUIRED';
  end if;

  -- Never trust a client-supplied timestamp.
  new.started_at := pg_catalog.now();

  -- Usage is still recorded per user and UTC day for statistics, but it no longer limits sessions.
  insert into private.speakwise_voice_daily_usage as u (owner_id, usage_day, session_count)
  values (v_user_id, v_day, 1)
  on conflict (owner_id, usage_day)
  do update set session_count = u.session_count + 1, updated_at = pg_catalog.now();

  return new;
end;
$$;

alter table private.speakwise_voice_daily_usage
  drop constraint if exists speakwise_voice_daily_usage_session_count_check;
alter table private.speakwise_voice_daily_usage
  add constraint speakwise_voice_daily_usage_session_count_check check (session_count >= 0);

alter table public.speakwise_voice_sessions
  drop constraint if exists speakwise_voice_sessions_duration_seconds_check;
alter table public.speakwise_voice_sessions
  add constraint speakwise_voice_sessions_duration_seconds_check
  check (duration_seconds is null or (duration_seconds >= 0 and duration_seconds <= 86400));
