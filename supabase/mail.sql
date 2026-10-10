create table if not exists public.prefs (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  mail boolean not null default false
);
alter table public.prefs enable row level security;
create policy "chacun ses prefs" on public.prefs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.prefs to authenticated;
