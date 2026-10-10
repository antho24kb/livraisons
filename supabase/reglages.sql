alter table public.prefs
  add column if not exists alert_expedie boolean not null default true,
  add column if not exists alert_livraison boolean not null default true,
  add column if not exists alert_livre boolean not null default true,
  add column if not exists alert_retard boolean not null default true,
  add column if not exists matin_on boolean not null default false,
  add column if not exists matin_h smallint not null default 8,
  add column if not exists silence_on boolean not null default false,
  add column if not exists silence_debut smallint not null default 22,
  add column if not exists silence_fin smallint not null default 8,
  add column if not exists matin_derniere date;
alter table public.colis add column if not exists retard_notifie date;
update public.colis set retard_notifie = current_date where recu = false and date_prevue < current_date and retard_notifie is null;
select cron.alter_job((select jobid from cron.job where jobname = 'notifier-3h'), schedule := '0 * * * *');
