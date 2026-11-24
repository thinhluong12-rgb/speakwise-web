-- Speakwise: server-recorded adult confirmation for Voice Mode.
-- Signed-in users confirm that they are 18+ by giving a birth date once. The date is
-- checked inside the database and is NEVER stored; only the outcome is kept.
-- This is a self-declaration, not identity verification. It sets the same server-controlled
-- app_metadata.adult_verified flag that the Worker, RPC, trigger and RLS policies already require.

create table if not exists private.speakwise_age_declarations (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  status text not null check (status in ('adult_declared', 'under_18_declared')),
  method text not null default 'self_declared_birth_date',
  declared_at timestamptz not null default pg_catalog.now()
);
alter table private.speakwise_age_declarations enable row level security;
revoke all on table private.speakwise_age_declarations from public, anon, authenticated, service_role;

create or replace function public.speakwise_confirm_adult(p_birth_date date, p_confirmed boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_today date := (pg_catalog.timezone('UTC', pg_catalog.now()))::date;
  v_adult_cutoff date := (v_today - interval '18 years')::date;
  v_status text;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'AUTH_REQUIRED';
  end if;

  select status into v_status
  from private.speakwise_age_declarations
  where owner_id = v_user_id;

  -- An account that has declared itself under 18 stays locked; retrying with another date does nothing.
  if v_status = 'under_18_declared' then
    return pg_catalog.jsonb_build_object('status', 'under_18');
  end if;

  -- Already confirmed: idempotent, makes sure the flag is present.
  if v_status = 'adult_declared' then
    update auth.users
    set raw_app_meta_data = pg_catalog.coalesce(raw_app_meta_data, '{}'::jsonb)
      || pg_catalog.jsonb_build_object('adult_verified', true)
    where id = v_user_id;
    return pg_catalog.jsonb_build_object('status', 'verified');
  end if;

  if p_confirmed is not true or p_birth_date is null
     or p_birth_date > v_today or p_birth_date < date '1900-01-01' then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  if p_birth_date > v_adult_cutoff then
    insert into private.speakwise_age_declarations(owner_id, status)
    values (v_user_id, 'under_18_declared')
    on conflict (owner_id) do update set status = 'under_18_declared', declared_at = pg_catalog.now();
    return pg_catalog.jsonb_build_object('status', 'under_18');
  end if;

  insert into private.speakwise_age_declarations(owner_id, status)
  values (v_user_id, 'adult_declared')
  on conflict (owner_id) do update set status = 'adult_declared', declared_at = pg_catalog.now();

  update auth.users
  set raw_app_meta_data = pg_catalog.coalesce(raw_app_meta_data, '{}'::jsonb)
    || pg_catalog.jsonb_build_object(
      'adult_verified', true,
      'adult_verification_method', 'self_declared_birth_date',
      'adult_verified_at', pg_catalog.now()
    )
  where id = v_user_id;

  return pg_catalog.jsonb_build_object('status', 'verified');
end;
$$;
revoke all on function public.speakwise_confirm_adult(date, boolean) from public, anon;
grant execute on function public.speakwise_confirm_adult(date, boolean) to authenticated;
