-- Vitrine Certa · Exige MFA (AAL2) nas operações administrativas de ofertas.
-- Aplicar SOMENTE após o painel com desafio TOTP estar publicado e validado.

begin;

drop policy if exists admins_read_all_offers on public.affiliate_products;
drop policy if exists admins_insert_offers on public.affiliate_products;
drop policy if exists admins_update_offers on public.affiliate_products;
drop policy if exists admins_delete_offers on public.affiliate_products;

create policy admins_read_all_offers on public.affiliate_products
  for select to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2'
    and exists (select 1 from public.admins a where a.user_id = auth.uid()));

create policy admins_insert_offers on public.affiliate_products
  for insert to authenticated
  with check ((select auth.jwt()->>'aal') = 'aal2'
    and exists (select 1 from public.admins a where a.user_id = auth.uid()));

create policy admins_update_offers on public.affiliate_products
  for update to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2'
    and exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check ((select auth.jwt()->>'aal') = 'aal2'
    and exists (select 1 from public.admins a where a.user_id = auth.uid()));

create policy admins_delete_offers on public.affiliate_products
  for delete to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2'
    and exists (select 1 from public.admins a where a.user_id = auth.uid()));

commit;

-- Reversão manual: reaplicar as quatro policies da migração
-- 20260924121000_admin_panel_security.sql, sem o predicado de AAL2.
