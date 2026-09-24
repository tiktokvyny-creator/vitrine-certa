-- Testes da migração admin_panel_security em Postgres LOCAL/DESCARTÁVEL.
-- Nunca executar este arquivo no banco de produção.
\set ON_ERROR_STOP 1
begin;

create or replace function pg_temp.ok(cond boolean, name text) returns void language plpgsql as $$
begin if cond then raise notice 'PASS %', name; else raise exception 'FAIL %', name; end if; end $$;

-- A) Privilégios anônimos: apenas leitura; nenhuma escrita ou poder estrutural.
select pg_temp.ok(has_table_privilege('anon','public.affiliate_products','SELECT'), 'anon pode ler ofertas');
select pg_temp.ok(not has_table_privilege('anon','public.affiliate_products','INSERT'), 'anon não insere');
select pg_temp.ok(not has_table_privilege('anon','public.affiliate_products','UPDATE'), 'anon não atualiza');
select pg_temp.ok(not has_table_privilege('anon','public.affiliate_products','DELETE'), 'anon não exclui');
select pg_temp.ok(not has_table_privilege('anon','public.affiliate_products','TRUNCATE'), 'anon não trunca');
select pg_temp.ok(not has_table_privilege('anon','public.affiliate_products','TRIGGER'), 'anon não cria trigger');
select pg_temp.ok(not has_table_privilege('anon','public.affiliate_products','REFERENCES'), 'anon não cria referência');

-- B) authenticated: sem poderes estruturais e UPDATE limitado às dez colunas.
select pg_temp.ok(not has_table_privilege('authenticated','public.affiliate_products','TRUNCATE'), 'authenticated não trunca');
select pg_temp.ok(not has_table_privilege('authenticated','public.affiliate_products','TRIGGER'), 'authenticated não cria trigger');
select pg_temp.ok(not has_column_privilege('authenticated','public.affiliate_products','title','UPDATE'), 'título original é imutável pelo painel');
select pg_temp.ok(not has_column_privilege('authenticated','public.affiliate_products','external_id','UPDATE'), 'external_id é imutável pelo painel');
select pg_temp.ok(not has_column_privilege('authenticated','public.affiliate_products','raw_payload','UPDATE'), 'raw_payload é imutável pelo painel');
select pg_temp.ok(has_column_privilege('authenticated','public.affiliate_products','display_title','UPDATE'), 'display_title pode ser editado');
select pg_temp.ok(has_column_privilege('authenticated','public.affiliate_products','active','UPDATE'), 'active pode ser alterado');

-- C) Policies canônicas: uma pública e quatro administrativas, sem duplicatas antigas.
select pg_temp.ok((select count(*) from pg_policies where schemaname='public' and tablename='affiliate_products') = 5,
  'affiliate_products tem exatamente cinco policies canônicas');
select pg_temp.ok((select count(*) from pg_policies where schemaname='public' and tablename='admins') = 1,
  'admins tem exatamente uma policy canônica');
select pg_temp.ok(not exists (
  select 1 from pg_policies where schemaname='public' and policyname in
  ('Admin acesso total a produtos afiliados','admins_manage_offers','Público lê produtos ativos','admin_can_read_own_membership')
), 'policies duplicadas antigas foram removidas');

-- D) Validações existem e estão ativas para novas gravações.
select pg_temp.ok((select count(*) from pg_constraint where conrelid='public.affiliate_products'::regclass
  and conname in ('ap_price_positive','ap_discount_range','ap_affiliate_https','ap_image_https')) = 4,
  'quatro constraints de integridade existem');

-- E) Compatibilidade do cadastro manual: somente as oito colunas atuais têm INSERT.
select pg_temp.ok(has_column_privilege('authenticated','public.affiliate_products','title','INSERT'), 'cadastro manual pode inserir título');
select pg_temp.ok(has_column_privilege('authenticated','public.affiliate_products','affiliate_url','INSERT'), 'cadastro manual pode inserir link');
select pg_temp.ok(not has_column_privilege('authenticated','public.affiliate_products','raw_payload','INSERT'), 'cadastro manual não insere raw_payload');
select pg_temp.ok(not has_column_privilege('authenticated','public.affiliate_products','external_id','INSERT'), 'cadastro manual não insere external_id');

rollback;
