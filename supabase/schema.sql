-- STUDENT HUB DATABASE
create extension if not exists pgcrypto;

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null,
  section text not null check (section in ('education','relaxation')),
  title text not null check (char_length(title) between 1 and 120),
  content text not null check (char_length(content) between 1 and 10000),
  status text not null default 'published' check (status in ('published','hidden','removed')),
  moderation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (char_length(reason) <= 1000),
  created_at timestamptz not null default now(),
  unique(post_id, reporter_id)
);

alter table public.posts enable row level security;
alter table public.reports enable row level security;

create policy "published posts are readable"
on public.posts for select using (status = 'published');

create policy "users can report"
on public.reports for insert to authenticated
with check (reporter_id = auth.uid());

-- IMPORTANT: users do NOT get direct INSERT/UPDATE permission on posts.
-- Only the server-side moderation function should create posts.

-- Admin helper: put your own user UUID into this table manually if desired.
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;
