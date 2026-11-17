create or replace function public.start_speakwise_voice_session(
  p_topic text default 'Daily conversation',
  p_cefr_level text default 'B1',
  p_learning_goals text[] default '{}',
  p_session_mode text default 'conversation'
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_count integer;
  v_topic text := left(trim(coalesce(p_topic, 'Daily conversation')), 120);
  v_level text := upper(coalesce(p_cefr_level, 'B1'));
  v_mode text := coalesce(p_session_mode, 'conversation');
  v_goals text[] := coalesce(p_learning_goals, '{}');
  v_day_start timestamptz := date_trunc('day', timezone('UTC', now())) at time zone 'UTC';
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'adult_verified', 'false') <> 'true' then
    raise exception using errcode = '42501', message = 'ADULT_VERIFICATION_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  select count(*)::integer into v_count
  from public.speakwise_voice_sessions
  where owner_id = v_user_id and started_at >= v_day_start;

  if v_count >= 5 then
    raise exception using errcode = 'P0001', message = 'DAILY_VOICE_LIMIT';
  end if;

  if v_topic = '' then v_topic := 'Daily conversation'; end if;
  if v_level not in ('A2', 'B1', 'B2', 'C1') then v_level := 'B1'; end if;
  if v_mode not in ('conversation', 'ielts_part_1', 'ielts_part_2', 'ielts_part_3') then v_mode := 'conversation'; end if;

  insert into public.speakwise_voice_sessions
    (owner_id, topic, cefr_level, learning_goals, session_mode, status)
  values
    (v_user_id, v_topic, v_level, v_goals[1:5], v_mode, 'active')
  returning id into v_session_id;
  return v_session_id;
end;
$$;

revoke all on function public.start_speakwise_voice_session(text, text, text[], text) from public;
revoke all on function public.start_speakwise_voice_session(text, text, text[], text) from anon;
grant execute on function public.start_speakwise_voice_session(text, text, text[], text) to authenticated;
