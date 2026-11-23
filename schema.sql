-- Workout Log database. Paste all of this into Supabase → SQL Editor → New query → Run.
-- Safe to run again: it only creates what is missing.
-- Every table is locked so each signed-in person can only read and write their own rows.

create table if not exists public.settings (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  date       date,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists sessions_user_date on public.sessions (user_id, date desc);

create table if not exists public.plans (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.drafts (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Counts AI plan requests per person per day, for the daily cap.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);

alter table public.settings enable row level security;
alter table public.sessions enable row level security;
alter table public.plans    enable row level security;
alter table public.drafts   enable row level security;
alter table public.ai_usage enable row level security;

do $$
declare t text;
begin
  foreach t in array array['settings','sessions','plans','drafts'] loop
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='own rows') then
      execute format('create policy "own rows" on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    end if;
  end loop;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ai_usage' and policyname='read own usage') then
    create policy "read own usage" on public.ai_usage for select to authenticated using (auth.uid() = user_id);
  end if;
end $$;

-- Adds one to today's count for the signed-in person and returns the new count.
create or replace function public.bump_ai_usage()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare c int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.ai_usage (user_id, day, count) values (auth.uid(), current_date, 1)
  on conflict (user_id, day) do update set count = public.ai_usage.count + 1
  returning count into c;
  return c;
end $$;

revoke all on function public.bump_ai_usage() from public, anon;
grant execute on function public.bump_ai_usage() to authenticated;
