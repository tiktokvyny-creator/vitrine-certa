-- Vitrine Certa · Execuções administrativas (busca de ofertas e verificação de preço)
-- Aplicar SOMENTE após aprovação. Idempotente. Não altera dados existentes.
-- Reverter: ver bloco "ROLLBACK" no fim do arquivo.

-- 1) Registro das execuções solicitadas pelo painel -----------------------------
create table if not exists public.admin_job_runs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('sync', 'price_check')),
  status        text not null default 'requested'
                check (status in ('requested', 'running', 'completed', 'failed', 'timeout', 'unconfirmed')),
  requested_by  uuid not null,
  product_id    text check (product_id is null or product_id ~ '^[A-Za-z0-9-]{1,64}$'),
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  found         integer check (found    is null or found    >= 0),
  rejected      integer check (rejected is null or rejected >= 0),
  approved      integer check (approved is null or approved >= 0),
  saved         integer check (saved    is null or saved    >= 0),
  error_code    text check (error_code is null or error_code ~ '^[a-z0-9_]{1,40}$')
);

-- Trava no banco: no máximo UMA busca pendente/em andamento por vez (protege contra clique duplo e corrida).
create unique index if not exists admin_job_runs_one_active_sync
  on public.admin_job_runs (kind) where kind = 'sync' and status in ('requested', 'running');
create index if not exists admin_job_runs_recent
  on public.admin_job_runs (kind, requested_by, created_at desc);
create index if not exists admin_job_runs_product
  on public.admin_job_runs (product_id, created_at desc) where kind = 'price_check';

alter table public.admin_job_runs enable row level security;
revoke all on public.admin_job_runs from anon, authenticated;
grant select on public.admin_job_runs to authenticated;
grant select, insert, update on public.admin_job_runs to service_role;
drop policy if exists admin_job_runs_admin_read on public.admin_job_runs;
create policy admin_job_runs_admin_read on public.admin_job_runs
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()));
-- Sem policy de escrita: só a service_role (Edge Function e n8n) grava aqui.

-- 2) Data/hora e resultado da última verificação de preço ------------------------
alter table public.affiliate_products add column if not exists price_checked_at   timestamptz;
alter table public.affiliate_products add column if not exists price_check_status text;
do $$ begin
  alter table public.affiliate_products add constraint ap_price_check_status
    check (price_check_status is null or price_check_status in ('confirmed', 'unconfirmed'));
exception when duplicate_object then null; end $$;

-- 3) Automação nunca decide pelo administrador -----------------------------------
-- Vale só para gravações feitas com a service_role (n8n / Edge Function):
--   • produto novo vindo de automação nasce active=false;
--   • em atualizações, active, display_title, category e sort_order ficam como estavam.
-- O painel (papel authenticated) e funções security definer não são afetados.
create or replace function public.protect_admin_decisions() returns trigger
language plpgsql as $$
begin
  if current_user = 'service_role' then
    if tg_op = 'INSERT' then
      if new.source = 'api' or new.external_id is not null then
        new.active := false;
      end if;
    elsif tg_op = 'UPDATE' then
      new.active        := old.active;
      new.display_title := old.display_title;
      new.category      := coalesce(old.category, new.category);
      new.sort_order    := old.sort_order;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists zz_protect_admin_decisions on public.affiliate_products;
create trigger zz_protect_admin_decisions
  before insert or update on public.affiliate_products
  for each row execute function public.protect_admin_decisions();

-- ROLLBACK (manual, se necessário):
--   drop trigger if exists zz_protect_admin_decisions on public.affiliate_products;
--   drop function if exists public.protect_admin_decisions();
--   alter table public.affiliate_products drop constraint if exists ap_price_check_status,
--     drop column if exists price_check_status, drop column if exists price_checked_at;
--   drop table if exists public.admin_job_runs;
