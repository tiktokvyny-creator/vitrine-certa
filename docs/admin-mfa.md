# MFA TOTP do painel administrativo

## Escopo

- O painel exige `aal2` antes de carregar dados administrativos.
- O primeiro acesso cadastra um TOTP principal.
- Um segundo TOTP verificado é obrigatório como fator de backup.
- A Edge Function `vc-admin-jobs` rejeita tokens em `aal1`.
- As policies administrativas de `affiliate_products` exigem `aal2`.

O Supabase Auth não oferece códigos de recuperação. Por isso, o fluxo usa um
segundo fator TOTP, conforme a recomendação oficial. O backup deve ficar em um
dispositivo ou aplicativo diferente do fator principal.

## Ordem segura para uma implantação futura

1. Publicar o painel com o fluxo TOTP.
2. Cadastrar e verificar os dois fatores do administrador.
3. Implantar a nova versão da Edge Function `vc-admin-jobs`.
4. Aplicar `20260925120000_admin_mfa_aal2.sql`.
5. Validar login, leitura e uma operação administrativa controlada.

Não aplicar a migração antes de o painel com MFA estar acessível e os fatores
terem sido cadastrados, para evitar bloquear o administrador em `aal1`.

## Testes locais

```sh
node --test tests/admin-mfa.test.cjs
node tests/run-postgres-mfa.mjs
```

Os testes da Edge Function continuam em
`supabase/functions/vc-admin-jobs/handler.test.ts` e incluem a rejeição de um
administrador autenticado apenas em `aal1`.
