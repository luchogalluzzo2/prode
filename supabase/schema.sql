create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  role text not null default 'player' check (role in ('player', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.predictions (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  awards jsonb not null default '{}'::jsonb,
  saved_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.real_results (
  id text primary key default 'official',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, username, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    'player'
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.predictions enable row level security;
alter table public.real_results enable row level security;

drop policy if exists "profiles select authenticated" on public.profiles;
create policy "profiles select authenticated"
on public.profiles for select
to authenticated
using (true);

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own"
on public.profiles for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "profiles update own or admin" on public.profiles;
create policy "profiles update own or admin"
on public.profiles for update
to authenticated
using (
  auth.uid() = user_id
  or exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'admin'
  )
)
with check (
  auth.uid() = user_id
  or exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'admin'
  )
);

drop policy if exists "predictions select own or admin" on public.predictions;
create policy "predictions select own or admin"
on public.predictions for select
to authenticated
using (
  auth.uid() = user_id
  or exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'admin'
  )
);

drop policy if exists "predictions upsert own" on public.predictions;
create policy "predictions upsert own"
on public.predictions for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "predictions update own" on public.predictions;
create policy "predictions update own"
on public.predictions for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "real results select authenticated" on public.real_results;
create policy "real results select authenticated"
on public.real_results for select
to authenticated
using (true);

drop policy if exists "real results insert admin" on public.real_results;
create policy "real results insert admin"
on public.real_results for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'admin'
  )
);

drop policy if exists "real results update admin" on public.real_results;
create policy "real results update admin"
on public.real_results for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'admin'
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'admin'
  )
);

insert into public.real_results (id, data)
values ('official', '{}'::jsonb)
on conflict (id) do nothing;
