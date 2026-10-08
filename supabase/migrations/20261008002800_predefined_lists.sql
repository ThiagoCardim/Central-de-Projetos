-- =============================================================================
-- 0028 · Listas pré-definidas no lugar de texto livre
--
--   * project_types: tipos de projeto (Residencial, Comercial...) para escolher
--     na venda. Valores iniciais = os já usados + uma lista base; o ADM Global edita.
--   * schedule_change_reasons.kind: a mesma tabela de motivos passa a ter listas
--     por uso (prazo, aguardando cliente, aguardando terceiro, impedimento,
--     cancelamento de etapa, recusa de ajuste, entrada ignorada). Em todas existe
--     "Outro motivo" com texto livre (na tela).
-- =============================================================================

create table public.project_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 2 and 60),
  sort_order int  not null default 100,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index project_types_name_uidx on public.project_types (lower(trim(name)));
create trigger project_types_touch before update on public.project_types for each row execute function private.touch_updated_at();
create trigger project_types_audit after insert or update on public.project_types for each row execute function private.audit_row();
alter table public.project_types enable row level security;
create policy project_types_select on public.project_types for select to authenticated using (private.is_staff());
create policy project_types_insert on public.project_types for insert to authenticated with check (private.is_global_admin());
create policy project_types_update on public.project_types for update to authenticated
  using (private.is_global_admin()) with check (private.is_global_admin());
revoke all on public.project_types from anon;
grant select, insert, update on public.project_types to authenticated;

insert into public.project_types (name, sort_order) values
  ('Residencial', 10), ('Comercial', 20), ('Corporativo', 30), ('Industrial', 40), ('Institucional', 50)
on conflict do nothing;
-- Tipos já usados em projetos e vendas continuam disponíveis.
insert into public.project_types (name, sort_order)
select distinct on (lower(trim(x))) initcap(trim(x)), 200
from (select project_type as x from public.projects union all select project_type from public.project_intakes) s
where length(trim(coalesce(x, ''))) between 2 and 60
on conflict do nothing;

-- Motivos por uso
alter table public.schedule_change_reasons add column kind text not null default 'schedule'
  check (kind in ('schedule', 'waiting_client', 'waiting_third_party', 'waiting_dependency', 'task_cancel', 'adjustment_reject', 'intake_ignore'));
create index schedule_change_reasons_kind_idx on public.schedule_change_reasons (kind, sort_order) where active;

insert into public.schedule_change_reasons (kind, label, client_visible, sort_order) values
  ('waiting_client', 'Aguardando aprovação do cliente', false, 10),
  ('waiting_client', 'Aguardando medidas ou levantamento do local', false, 20),
  ('waiting_client', 'Aguardando documentos do imóvel', false, 30),
  ('waiting_client', 'Aguardando definições do cliente (layout, acabamentos)', false, 40),
  ('waiting_client', 'Aguardando pagamento', false, 50),
  ('waiting_third_party', 'Aguardando prefeitura ou órgão público', false, 10),
  ('waiting_third_party', 'Aguardando concessionária (energia, água, gás)', false, 20),
  ('waiting_third_party', 'Aguardando topografia ou sondagem', false, 30),
  ('waiting_third_party', 'Aguardando fornecedor ou consultor externo', false, 40),
  ('waiting_dependency', 'Aguardando outro setor da YouCon', false, 10),
  ('waiting_dependency', 'Informação técnica pendente', false, 20),
  ('waiting_dependency', 'Conflito entre disciplinas a resolver', false, 30),
  ('waiting_dependency', 'Responsável indisponível no momento', false, 40),
  ('task_cancel', 'Etapa não se aplica a este projeto', false, 10),
  ('task_cancel', 'Escopo alterado pelo cliente', false, 20),
  ('task_cancel', 'Cliente desistiu do serviço', false, 30),
  ('task_cancel', 'Etapa feita fora da plataforma', false, 40),
  ('adjustment_reject', 'Solução já aprovada pelo cliente', false, 10),
  ('adjustment_reject', 'Resolver na compatibilização', false, 20),
  ('adjustment_reject', 'Fora do escopo contratado', false, 30),
  ('adjustment_reject', 'Pedido sem informação suficiente: reenviar com detalhes', false, 40),
  ('intake_ignore', 'Card de teste', false, 10),
  ('intake_ignore', 'Venda duplicada', false, 20),
  ('intake_ignore', 'Venda cancelada antes do início', false, 30),
  ('intake_ignore', 'Lançada por engano', false, 40)
on conflict do nothing;
