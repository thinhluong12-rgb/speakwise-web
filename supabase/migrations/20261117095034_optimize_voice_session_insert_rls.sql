drop policy if exists "Users can create their own voice sessions" on public.speakwise_voice_sessions;
create policy "Users can create their own voice sessions"
  on public.speakwise_voice_sessions for insert to authenticated
  with check (
    (select auth.uid()) = owner_id
    and coalesce((select auth.jwt() -> 'app_metadata' ->> 'adult_verified'), 'false') = 'true'
  );
