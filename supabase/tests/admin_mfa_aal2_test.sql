-- Teste LOCAL/DESCARTÁVEL da migração de MFA. Nunca executar em produção.
\set ON_ERROR_STOP 1
begin;

create or replace function pg_temp.ok(cond boolean, name text) returns void language plpgsql as $$
begin if cond then raise notice 'PASS %', name; else raise exception 'FAIL %', name; end if; end $$;

select pg_temp.ok((select count(*) = 4 from pg_policies
  where schemaname = 'public' and tablename = 'affiliate_products'
    and policyname in ('admins_read_all_offers','admins_insert_offers','admins_update_offers','admins_delete_offers')
    and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%aal2%'),
  'as quatro policies administrativas exigem AAL2');

select pg_temp.ok((select count(*) = 1 from pg_policies
  where schemaname = 'public' and tablename = 'affiliate_products'
    and policyname = 'public_read_active_offers'), 'leitura pública foi preservada');

select pg_temp.ok((select count(*) = 1 from pg_policies
  where schemaname = 'public' and tablename = 'admins'
    and policyname = 'admins_read_own_membership'),
  'associação admin continua consultável antes do desafio MFA');

rollback;
