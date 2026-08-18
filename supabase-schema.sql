create table if not exists public.fp_posts (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('image', 'pdf')),
  title text not null,
  category text not null check (category in ('상품', '시상')),
  author text not null default '관리자',
  tags text[] not null default '{}',
  description text not null default '',
  media_url text not null,
  storage_path text,
  ratio text not null default '4/5',
  created_at timestamptz not null default now()
);

create table if not exists public.fp_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.fp_posts(id) on delete cascade,
  author text not null default '방문자',
  text text not null,
  created_at timestamptz not null default now()
);

alter table public.fp_posts enable row level security;
alter table public.fp_comments enable row level security;

create policy "Public can read fp posts"
on public.fp_posts for select
to anon
using (true);

create policy "Public can create fp posts"
on public.fp_posts for insert
to anon
with check (true);

create policy "Public can delete fp posts"
on public.fp_posts for delete
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

insert into storage.buckets (id, name, public)
values ('fp-lounge-media', 'fp-lounge-media', true)
on conflict (id) do update set public = true;

create policy "Public can read lounge media"
on storage.objects for select
to anon
using (bucket_id = 'fp-lounge-media');

create policy "Public can upload lounge media"
on storage.objects for insert
to anon
with check (bucket_id = 'fp-lounge-media');

create policy "Public can delete lounge media"
on storage.objects for delete
to anon
using (bucket_id = 'fp-lounge-media');
