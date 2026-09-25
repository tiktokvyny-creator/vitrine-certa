-- Vitrine Certa · Menor privilégio e policies canônicas do painel
-- Aplicar SOMENTE após revisão e aprovação explícita.
-- Esta migração não altera linhas de produtos; altera apenas privilégios,
-- policies RLS e validações para gravações futuras.

begin;

-- 1) Ofertas: remover privilégios amplos herdados do bootstrap do projeto.
alter table public.affiliate_products enable row level security;
revoke all privileges on table public.affiliate_products from public, anon, authenticated;

-- Visitantes e usuários logados podem ler; o RLS decide quais linhas aparecem.
grant select on table public.affiliate_products to anon, authenticated;

-- Compatibilidade temporária com o admin.html antigo: cadastro manual somente
-- com as oito colunas que ele realmente envia. Campos técnicos ficam bloqueados.
grant insert (title, price, category, image_url, affiliate_url, active, source, sort_order)
  on table public.affiliate_products to authenticated;

-- O painel novo pode alterar somente estes dez campos comerciais/aprovação.
grant update (display_title, category, price, old_price, discount_percent,
              image_url, affiliate_url, merchant, sort_order, active)
  on table public.affiliate_products to authenticated;
grant delete on table public.affiliate_products to authenticated;

-- Remove as policies duplicadas encontradas na auditoria de 24/09/2026.
drop policy if exists "Admin acesso total a produtos afiliados" on public.affiliate_products;
drop policy if exists admins_manage_offers on public.affiliate_products;
drop policy if exists "Público lê produtos ativos" on public.affiliate_products;
drop policy if exists public_read_active_offers on public.affiliate_products;
drop policy if exists admins_read_all_offers on public.affiliate_products;
drop policy if exists admins_insert_offers on public.affiliate_products;
drop policy if exists admins_update_offers on public.affiliate_products;
drop policy if exists admins_delete_offers on public.affiliate_products;

create policy public_read_active_offers on public.affiliate_products
  for select to anon
  using (active = true and (expires_at is null or expires_at > now()));

create policy admins_read_all_offers on public.affiliate_products
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()));

create policy admins_insert_offers on public.affiliate_products
  for insert to authenticated
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

create policy admins_update_offers on public.affiliate_products
  for update to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

create policy admins_delete_offers on public.affiliate_products
  for delete to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()));

-- 2) Tabela de administradores: somente a própria associação pode ser lida.
alter table public.admins enable row level security;
revoke all privileges on table public.admins from public, anon, authenticated;
grant select (user_id) on table public.admins to authenticated;

drop policy if exists "Cada usuário só vê se ele mesmo é admin" on public.admins;
drop policy if exists admin_can_read_own_membership on public.admins;
drop policy if exists admins_read_own_membership on public.admins;

create policy admins_read_own_membership on public.admins
  for select to authenticated
  using (user_id = auth.uid());

-- 3) Validação no banco para gravações novas/alteradas.
-- NOT VALID evita bloquear a migração por dados legados; a regra já passa a
-- valer para toda nova inserção ou atualização.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ap_price_positive'
                 and conrelid = 'public.affiliate_products'::regclass) then
    alter table public.affiliate_products add constraint ap_price_positive
      check (price is null or price > 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ap_discount_range'
                 and conrelid = 'public.affiliate_products'::regclass) then
    alter table public.affiliate_products add constraint ap_discount_range
      check (discount_percent is null or discount_percent between 0 and 100) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ap_affiliate_https'
                 and conrelid = 'public.affiliate_products'::regclass) then
    alter table public.affiliate_products add constraint ap_affiliate_https
      check (affiliate_url is null or affiliate_url ~* '^https://') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ap_image_https'
                 and conrelid = 'public.affiliate_products'::regclass) then
    alter table public.affiliate_products add constraint ap_image_https
      check (image_url is null or image_url ~* '^https://') not valid;
  end if;
end $$;

commit;

-- Reversão manual de emergência (não executar junto com a migração):
-- begin;
-- drop policy if exists public_read_active_offers on public.affiliate_products;
-- drop policy if exists admins_read_all_offers on public.affiliate_products;
-- drop policy if exists admins_insert_offers on public.affiliate_products;
-- drop policy if exists admins_update_offers on public.affiliate_products;
-- drop policy if exists admins_delete_offers on public.affiliate_products;
-- grant all privileges on table public.affiliate_products to anon, authenticated;
-- alter table public.affiliate_products drop constraint if exists ap_price_positive,
--   drop constraint if exists ap_discount_range,
--   drop constraint if exists ap_affiliate_https,
--   drop constraint if exists ap_image_https;
-- grant select on table public.admins to authenticated;
-- commit;
