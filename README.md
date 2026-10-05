# Portal de Projetos YouCon

Sistema central de gestão de projetos da YouCon Arquitetura e Engenharia, multi-tenant
(franqueadora + franquias), com RBAC aplicado no banco via RLS.

Stack: React · Supabase (Postgres, Auth, Storage, Edge Functions) · Vercel.

## Estado atual — Etapa 1 (em andamento)

| Camada | Situação |
|---|---|
| Schema completo (Etapas 1–3.1 modeladas) | pronto |
| Funções centrais de permissão + RLS em todas as tabelas | pronto, testado |
| Auditoria append-only com ação semântica | pronto, testado |
| Bloqueio de usuário/unidade inativa (auth hook) | pronto, testado |
| Catálogo de serviços, pacotes e templates v1 | pronto |
| RPCs de usuários, unidades e Home por perfil | pronto, testado |
| Edge Function `admin-users` (convite, edição, desativação) | pronto |
| Frontend: design system YouCon (dark/light), login, recuperação e definição de senha | pronto |
| Home "painel do avião" por perfil (cliente, CLT, PJ, líder, ADM unidade, ADM global) | pronto |
| Controle de Acessos (convite, edição, CLT/PJ, B2C/B2B, desativação) e Unidades | pronto |

## Estrutura

```
supabase/
  migrations/   0001 fundação · 0002 entrada/projetos · 0003 catálogo/cronograma
                0004 dados mestres · 0005 RPCs de usuários e Home
  functions/    admin-users (+ _shared)
  tests/        testes SQL de segurança (96 asserções)
  config.toml   cadastro público desabilitado, auth hook habilitado
scripts/test-db.sh
```

## Modelo de acesso

| Perfil | Escopo |
|---|---|
| ADM Global (`global_admin`) | Todas as unidades, usuários, projetos, templates e distribuição. Só existe na franqueadora. |
| ADM Unidade (`unit_admin`) | Somente o próprio tenant. Não cria ADM Global, não altera regras globais. |
| Líder (`leader`) | Projetos executados/vendidos pela unidade; edita cronogramas e equipe; vê performance só de CLT. |
| Colaborador (`collaborator`, CLT/PJ) | Somente projetos em que está na equipe; atualiza status e datas reais das próprias etapas. PJ nunca vê performance. |
| Cliente (`client`, B2C/B2B) | Somente projetos do cliente ao qual está vinculado, por RPC com colunas seguras (sem justificativas internas). |

Todas as regras ficam em `private.can_*` (ex.: `can_manage_users`, `can_view_project`,
`can_assign_team`, `can_view_performance`, `can_manage_tenant`, `can_edit_schedule`,
`can_manage_templates`). O frontend só usa `my_permissions()` para exibir ou ocultar a interface.

## Deploy do frontend (Vercel)

1. Importe o repositório na Vercel (framework detectado: Vite).
2. Em *Environment Variables*, defina `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
3. Publique. Cada push na `main` gera um novo deploy.

`vercel.json` já configura o fallback de SPA e cabeçalhos de segurança (CSP, HSTS, X-Frame-Options).

## Preview visual sem npm

`scripts/preview` compila o app com esbuild contra um Supabase simulado e tira screenshots
de cada perfil (`?as=global_admin|unit_admin|leader|clt|pj|client|empty`). Só para revisão
visual: o mock nunca entra no build de produção.

## Rodando os testes de banco

Requer Postgres 15+ local:

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres scripts/test-db.sh
```

## Implantação no Supabase

1. `supabase link --project-ref <ref>` e `supabase db push`.
2. Authentication → Hooks → *Customize Access Token* → `public.custom_access_token_hook`.
3. Authentication → Providers → Email: desabilitar *Allow new users to sign up*.
4. `supabase functions deploy admin-users` e definir os segredos `APP_URL` e `APP_ALLOWED_ORIGINS`.
5. Criar o primeiro ADM Global: convidar o e-mail pelo painel do Supabase Auth e inserir o perfil
   na franqueadora (`00000000-0000-4000-8000-000000000001`) com `role = 'global_admin'`.
