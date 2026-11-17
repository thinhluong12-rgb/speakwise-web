create table if not exists public.speakwise_voice_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  topic text not null default 'Daily conversation' check (char_length(topic) between 1 and 120),
  cefr_level text not null default 'B1' check (cefr_level in ('A2','B1','B2','C1')),
  learning_goals text[] not null default '{}',
  session_mode text not null default 'conversation' check (session_mode in ('conversation','ielts_part_1','ielts_part_2','ielts_part_3')),
  status text not null default 'active' check (status in ('active','completed','failed','abandoned')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds between 0 and 7200),
  analysis_status text not null default 'not_requested' check (analysis_status in ('not_requested','pending','completed','failed')),
  analysis jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint speakwise_voice_sessions_id_owner_unique unique (id, owner_id),
  constraint speakwise_voice_sessions_time_check check (ended_at is null or ended_at >= started_at)
);

create table if not exists public.speakwise_voice_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  turn_id text not null check (char_length(turn_id) between 1 and 120),
  turn_index integer not null check (turn_index >= 0),
  speaker text not null check (speaker in ('user','assistant')),
  text text not null default '' check (char_length(text) <= 12000),
  occurred_at timestamptz not null default now(),
  status text not null default 'final' check (status in ('partial','final','interrupted')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint speakwise_voice_turns_session_owner_fk
    foreign key (session_id, owner_id)
    references public.speakwise_voice_sessions(id, owner_id)
    on delete cascade,
  constraint speakwise_voice_turns_session_turn_speaker_unique
    unique (session_id, turn_id, speaker)
);

create index if not exists speakwise_voice_sessions_owner_started_idx
  on public.speakwise_voice_sessions (owner_id, started_at desc);
create index if not exists speakwise_voice_turns_session_order_idx
  on public.speakwise_voice_turns (session_id, turn_index asc);
create index if not exists speakwise_voice_turns_owner_created_idx
  on public.speakwise_voice_turns (owner_id, created_at desc);

alter table public.speakwise_voice_sessions enable row level security;
alter table public.speakwise_voice_turns enable row level security;

drop policy if exists "Users can read their own voice sessions" on public.speakwise_voice_sessions;
create policy "Users can read their own voice sessions"
  on public.speakwise_voice_sessions for select to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "Users can create their own voice sessions" on public.speakwise_voice_sessions;
create policy "Users can create their own voice sessions"
  on public.speakwise_voice_sessions for insert to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can update their own voice sessions" on public.speakwise_voice_sessions;
create policy "Users can update their own voice sessions"
  on public.speakwise_voice_sessions for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can delete their own voice sessions" on public.speakwise_voice_sessions;
create policy "Users can delete their own voice sessions"
  on public.speakwise_voice_sessions for delete to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "Users can read their own voice turns" on public.speakwise_voice_turns;
create policy "Users can read their own voice turns"
  on public.speakwise_voice_turns for select to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "Users can create their own voice turns" on public.speakwise_voice_turns;
create policy "Users can create their own voice turns"
  on public.speakwise_voice_turns for insert to authenticated
  with check (
    (select auth.uid()) = owner_id
    and exists (
      select 1 from public.speakwise_voice_sessions s
      where s.id = session_id and s.owner_id = (select auth.uid())
    )
  );

drop policy if exists "Users can update their own voice turns" on public.speakwise_voice_turns;
create policy "Users can update their own voice turns"
  on public.speakwise_voice_turns for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can delete their own voice turns" on public.speakwise_voice_turns;
create policy "Users can delete their own voice turns"
  on public.speakwise_voice_turns for delete to authenticated
  using ((select auth.uid()) = owner_id);

grant select, insert, update, delete on public.speakwise_voice_sessions to authenticated;
grant select, insert, update, delete on public.speakwise_voice_turns to authenticated;
