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

1. Disponibilizar e validar o preview do PR, sem promover para produção.
2. No preview, cadastrar e verificar o TOTP principal e o TOTP de backup.
3. Confirmar no preview que a sessão atingiu `aal2` e que o painel abriu.
4. Implantar a Edge Function `vc-admin-jobs` que rejeita sessões em `aal1`.
5. Aplicar `20260925120000_admin_mfa_aal2.sql` imediatamente depois da função.
6. Promover o painel com MFA para produção.
7. Validar login, leitura e uma operação administrativa controlada.

Os passos 4, 5 e 6 devem ser executados na mesma janela de mudança. Entre a
proteção do backend e a promoção do painel, o painel antigo pode deixar de
funcionar; isso é preferível a manter uma janela em que chamadas administrativas
diretas ainda aceitem `aal1`.

Não aplicar a migração antes de os dois fatores terem sido verificados no
preview. Se a promoção do painel falhar, reverter primeiro a migração conforme o
bloco de reversão e só então restaurar a versão anterior da Edge Function.

## Testes locais

```sh
node --test tests/admin-mfa.test.cjs
node tests/run-postgres-mfa.mjs
```

Os testes da Edge Function continuam em
`supabase/functions/vc-admin-jobs/handler.test.ts` e incluem a rejeição de um
administrador autenticado apenas em `aal1`.
