create index if not exists speakwise_voice_turns_session_owner_order_idx
  on public.speakwise_voice_turns (session_id, owner_id, turn_index);

create index if not exists speakwise_activity_entry_id_idx
  on public.speakwise_activity (entry_id);

create index if not exists speakwise_mistakes_entry_id_idx
  on public.speakwise_mistakes (entry_id);
