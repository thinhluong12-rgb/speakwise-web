create or replace function public.start_speakwise_voice_session(
  p_topic text default 'Daily conversation',
  p_cefr_level text default 'B1',
  p_learning_goals text[] default '{}',
  p_session_mode text default 'conversation'
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_topic text := pg_catalog.left(pg_catalog.trim(pg_catalog.coalesce(p_topic, 'Daily conversation')), 120);
  v_level text := pg_catalog.upper(pg_catalog.coalesce(p_cefr_level, 'B1'));
  v_mode text := pg_catalog.coalesce(p_session_mode, 'conversation');
  v_goals text[] := pg_catalog.coalesce(p_learning_goals, '{}');
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;
  if pg_catalog.coalesce(auth.jwt() -> 'app_metadata' ->> 'adult_verified', 'false') <> 'true' then
    raise exception using errcode = '42501', message = 'ADULT_VERIFICATION_REQUIRED';
  end if;
  if v_topic = '' then v_topic := 'Daily conversation'; end if;
  if v_level not in ('A2', 'B1', 'B2', 'C1') then v_level := 'B1'; end if;
  if v_mode not in ('conversation', 'ielts_part_1', 'ielts_part_2', 'ielts_part_3') then v_mode := 'conversation'; end if;
  insert into public.speakwise_voice_sessions
    (owner_id, topic, cefr_level, learning_goals, session_mode, status)
  values (v_user_id, v_topic, v_level, v_goals[1:5], v_mode, 'active')
  returning id into v_session_id;
  return v_session_id;
end;
$$;
revoke all on function public.start_speakwise_voice_session(text, text, text[], text) from public, anon;
grant execute on function public.start_speakwise_voice_session(text, text, text[], text) to authenticated;

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
  v_count integer;
begin
  if v_user_id is null or new.owner_id is distinct from v_user_id then
    raise exception using errcode = '42501', message = 'VOICE_OWNER_MISMATCH';
  end if;
  if pg_catalog.coalesce(v_claims -> 'app_metadata' ->> 'adult_verified', 'false') <> 'true' then
    raise exception using errcode = '42501', message = 'ADULT_VERIFICATION_REQUIRED';
  end if;
  new.started_at := pg_catalog.now();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 0));
  insert into private.speakwise_voice_daily_usage(owner_id, usage_day, session_count)
  values (v_user_id, v_day, 0)
  on conflict (owner_id, usage_day) do nothing;
  select session_count into v_count
  from private.speakwise_voice_daily_usage
  where owner_id = v_user_id and usage_day = v_day
  for update;
  if v_count >= 5 then
    raise exception using errcode = 'P0001', message = 'DAILY_VOICE_LIMIT';
  end if;
  update private.speakwise_voice_daily_usage
  set session_count = v_count + 1, updated_at = pg_catalog.now()
  where owner_id = v_user_id and usage_day = v_day;
  return new;
end;
$$;
revoke all on function private.enforce_speakwise_voice_daily_quota() from public, anon, authenticated;
drop trigger if exists enforce_speakwise_voice_daily_quota on public.speakwise_voice_sessions;
create trigger enforce_speakwise_voice_daily_quota
before insert on public.speakwise_voice_sessions
for each row execute function private.enforce_speakwise_voice_daily_quota();
drop policy if exists "Users can create their own voice sessions" on public.speakwise_voice_sessions;
create policy "Users can create their own voice sessions"
  on public.speakwise_voice_sessions for insert to authenticated
  with check (
    (select auth.uid()) = owner_id
    and coalesce((select auth.jwt() -> 'app_metadata' ->> 'adult_verified'), 'false') = 'true'
  );
grant insert on table public.speakwise_voice_sessions to authenticated;
