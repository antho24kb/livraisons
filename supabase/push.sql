-- 1) Abonnements push (un par appareil)
create table if not exists public.push_subs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  cree_le timestamptz default now()
);
alter table public.push_subs enable row level security;
create policy "chacun ses abonnements" on public.push_subs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.push_subs to authenticated;

-- 2) Dernier statut notifié, mis à jour tout seul quand TU changes un statut à la main
alter table public.colis add column if not exists notif_cle text;
update public.colis set notif_cle = case when recu then 'recu' else statut end where notif_cle is null;
create or replace function public.colis_notif_cle() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.notif_cle := case when new.recu then 'recu' else new.statut end;
  elsif (case when new.recu then 'recu' else new.statut end) is distinct from (case when old.recu then 'recu' else old.statut end)
        and new.derniere_maj is not distinct from old.derniere_maj then
    new.notif_cle := case when new.recu then 'recu' else new.statut end;
  end if;
  return new;
end $$;
drop trigger if exists colis_notif_cle on public.colis;
create trigger colis_notif_cle before insert or update on public.colis
  for each row execute function public.colis_notif_cle();
