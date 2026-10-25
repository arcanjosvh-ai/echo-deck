-- Run once in the Supabase SQL editor.

-- One row per Echo Deck user, created on their first request. Approve people by ticking `approved` here.
create table public.echo_members (
  user_id uuid primary key references auth.users on delete cascade,
  email text,
  approved boolean not null default false,
  daily_limits jsonb not null default '{"cards": 30, "tts": 500, "stt": 10}',
  created_at timestamptz not null default now()
);

create table public.echo_usage (
  user_id uuid references auth.users on delete cascade,
  day date not null default current_date,
  task text not null,
  n int not null default 0,
  primary key (user_id, day, task)
);

-- RLS on with no policies: only the edge function (service role) and the dashboard can read or write these.
alter table public.echo_members enable row level security;
alter table public.echo_usage enable row level security;

-- Counts one call atomically. null = not approved, false = over today's limit, true = go ahead.
-- A user's first Echo Deck request creates their unapproved row (no trigger on the shared auth.users table).
-- ponytail: counts requests, not cost; meter tokens/characters/seconds once you bill per use.
create function public.echo_use_quota(p_uid uuid, p_task text) returns boolean language plpgsql security definer set search_path = '' as $$
declare lim int; used int;
begin
  insert into public.echo_members (user_id, email) select id, email from auth.users where id = p_uid on conflict do nothing;
  select (daily_limits ->> p_task)::int into lim from public.echo_members where user_id = p_uid and approved;
  if not found then return null; end if;
  insert into public.echo_usage as u (user_id, task, n) values (p_uid, p_task, 1)
    on conflict (user_id, day, task) do update set n = u.n + 1
    returning n into used;
  return used <= lim;
end $$;
revoke execute on function public.echo_use_quota from public, anon, authenticated;
