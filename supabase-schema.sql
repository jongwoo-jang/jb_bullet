create table if not exists public.fp_posts (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('image', 'pdf')),
  title text not null,
  category text not null check (category in ('상품', '시상')),
  author text not null default '관리자',
  tags text[] not null default '{}',
  description text not null default '',
  media_url text not null,
  download_url text,
  web_view_url text,
  storage_provider text not null default 'google_drive',
  drive_file_id text,
  storage_path text,
  ratio text not null default '4/5',
  created_at timestamptz not null default now()
);

alter table public.fp_posts add column if not exists download_url text;
alter table public.fp_posts add column if not exists web_view_url text;
alter table public.fp_posts add column if not exists storage_provider text not null default 'google_drive';
alter table public.fp_posts add column if not exists drive_file_id text;

create table if not exists public.fp_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.fp_posts(id) on delete cascade,
  author text not null default '방문자',
  text text not null,
  created_at timestamptz not null default now()
);

alter table public.fp_posts enable row level security;
alter table public.fp_comments enable row level security;

drop policy if exists "Public can read fp posts" on public.fp_posts;
drop policy if exists "Public can create fp posts" on public.fp_posts;
drop policy if exists "Public can delete fp posts" on public.fp_posts;
drop policy if exists "Public can read fp comments" on public.fp_comments;
drop policy if exists "Public can create fp comments" on public.fp_comments;

create policy "Public can read fp posts"
on public.fp_posts for select
to anon
using (true);

create policy "Public can read fp comments"
on public.fp_comments for select
to anon
using (true);

create policy "Public can create fp comments"
on public.fp_comments for insert
to anon
with check (true);

grant usage on schema public to anon, authenticated;
grant select on public.fp_posts to anon, authenticated;
grant select, insert on public.fp_comments to anon, authenticated;
