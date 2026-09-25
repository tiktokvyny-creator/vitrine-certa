-- Testes da migração admin_jobs (rodados em Postgres local descartável).
\set ON_ERROR_STOP 1
create or replace function pg_temp.ok(cond boolean, name text) returns void language plpgsql as $$
begin if cond then raise notice 'PASS %', name; else raise exception 'FAIL %', name; end if; end $$;

-- A) service_role (n8n): produto novo da automação nasce inativo mesmo pedindo active=true
set role service_role;
insert into public.affiliate_products(title, price, source, network, external_id, active, category)
values ('Feed item', 100, 'api', 'admitad', 'AE-1', true, 'Casa');
reset role;
select pg_temp.ok((select active from public.affiliate_products where external_id='AE-1') = false, 'produto novo da automação nasce active=false');

-- B) formulário/manual pela service_role (sem external_id, source nulo) mantém o comportamento atual
set role service_role;
insert into public.affiliate_products(title, price, active) values ('Manual via form', 50, true);
reset role;
select pg_temp.ok((select active from public.affiliate_products where title='Manual via form') = true, 'cadastro manual existente não é afetado');

-- C) administrador (authenticated) aprova, renomeia e ordena
set role authenticated; select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', false);
update public.affiliate_products set active=true, display_title='Título manual PT', category='Eletrônicos', sort_order=1 where external_id='AE-1';
reset role;
select pg_temp.ok((select active and display_title='Título manual PT' from public.affiliate_products where external_id='AE-1'), 'admin consegue ativar e editar');

-- D) nova sincronização (upsert da service_role) tenta sobrescrever decisões do admin
set role service_role;
insert into public.affiliate_products(title, price, old_price, source, network, external_id, active, display_title, category, sort_order)
values ('Feed item v2', 80, 120, 'api', 'admitad', 'AE-1', false, null, 'Outros', 99)
on conflict (network, external_id) do update set title=excluded.title, price=excluded.price, old_price=excluded.old_price,
  active=excluded.active, display_title=excluded.display_title, category=excluded.category, sort_order=excluded.sort_order;
reset role;
select pg_temp.ok((select active from public.affiliate_products where external_id='AE-1'), 'produto ativo continua ativo após sync');
select pg_temp.ok((select display_title='Título manual PT' from public.affiliate_products where external_id='AE-1'), 'display_title manual preservado');
select pg_temp.ok((select category='Eletrônicos' and sort_order=1 from public.affiliate_products where external_id='AE-1'), 'categoria e ordem preservadas');
select pg_temp.ok((select price=80 and old_price=120 and title='Feed item v2' from public.affiliate_products where external_id='AE-1'), 'preço e dados do feed atualizados');

-- E) verificação de preço (Edge Function com service_role) grava data/hora e status, sem mexer em active
set role service_role;
update public.affiliate_products set price=75, old_price=120, discount_percent=38, price_checked_at=now(), price_check_status='confirmed' where external_id='AE-1';
reset role;
select pg_temp.ok((select active and price=75 and price_check_status='confirmed' and price_checked_at is not null from public.affiliate_products where external_id='AE-1'), 'verificação atualiza preço e registra data sem alterar active');
do $$ begin
  update public.affiliate_products set price_check_status='inventado' where external_id='AE-1';
  raise exception 'FAIL status inválido aceito';
exception when check_violation then raise notice 'PASS status de verificação inválido recusado'; end $$;

-- F) trava de execução única da busca
set role service_role;
insert into public.admin_job_runs(kind, status, requested_by) values ('sync','requested','11111111-1111-1111-1111-111111111111');
do $$ begin
  insert into public.admin_job_runs(kind, status, requested_by) values ('sync','running','11111111-1111-1111-1111-111111111111');
  raise exception 'FAIL segunda busca simultânea aceita';
exception when unique_violation then raise notice 'PASS segunda busca simultânea recusada pelo banco'; end $$;
update public.admin_job_runs set status='completed', finished_at=now(), found=10, rejected=2, approved=8, saved=8 where kind='sync';
insert into public.admin_job_runs(kind, status, requested_by) values ('sync','requested','11111111-1111-1111-1111-111111111111');
insert into public.admin_job_runs(kind, status, requested_by, product_id) values ('price_check','completed','11111111-1111-1111-1111-111111111111','1');
insert into public.admin_job_runs(kind, status, requested_by, error_code) values ('price_check','failed','11111111-1111-1111-1111-111111111111','n8n_timeout');
reset role;
select pg_temp.ok(true, 'nova busca permitida após a anterior terminar');
select pg_temp.ok((select count(*) from public.admin_job_runs where error_code='n8n_timeout')=1, 'códigos com dígitos (n8n_timeout) são aceitos');
do $$ begin
  insert into public.admin_job_runs(kind, status, requested_by, error_code) values ('price_check','failed','11111111-1111-1111-1111-111111111111','Bearer abc.def');
  raise exception 'FAIL error_code livre aceito';
exception when check_violation then raise notice 'PASS error_code só aceita códigos simples (sem texto livre/tokens)'; end $$;

-- G) RLS de admin_job_runs
set role authenticated; select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222', false);
select pg_temp.ok((select count(*) from public.admin_job_runs) = 0, 'não-admin não vê execuções');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', false);
select pg_temp.ok((select count(*) from public.admin_job_runs) >= 3, 'admin vê execuções');
do $$ begin
  insert into public.admin_job_runs(kind, requested_by) values ('sync','11111111-1111-1111-1111-111111111111');
  raise exception 'FAIL navegador conseguiu gravar execução';
exception when insufficient_privilege then raise notice 'PASS navegador (authenticated) não grava execuções'; end $$;
reset role;
set role anon;
do $$ begin perform 1 from public.admin_job_runs; raise exception 'FAIL anon leu execuções';
exception when insufficient_privilege then raise notice 'PASS anon não lê execuções'; end $$;
reset role;
