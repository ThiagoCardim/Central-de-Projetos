-- =============================================================================
-- Portal de Projetos YouCon — Migration 0004: Dados mestres
-- Franqueadora, calendário padrão, catálogo de serviços, pacotes e templates v1.
-- Prazos SOMENTE os fornecidos pela YouCon; etapas sem prazo ficam "a definir".
-- =============================================================================

-- Franqueadora (id fixo para referência em integrações e seeds).
insert into public.tenants (id, name, type, slug, status)
values ('00000000-0000-4000-8000-000000000001', 'YouCon Franqueadora', 'franqueadora', 'youcon', 'ativo');

-- Calendário global padrão (seg–sex). Feriados são cadastrados pela administração.
insert into public.business_calendars (id, tenant_id, name, workdays, is_default)
values ('00000000-0000-4000-8000-000000000101', null, 'Calendário YouCon', '{1,2,3,4,5}', true);

-- -----------------------------------------------------------------------------
-- Famílias
-- -----------------------------------------------------------------------------
insert into public.service_families (code, name, default_project_role, sort_order) values
  ('arquitetura',       'Arquitetura',            'architecture', 10),
  ('engenharia',        'Engenharia',             'engineering',  20),
  ('orcamentos',        'Orçamentos',             'budget',       30),
  ('interiores',        'Interiores',             'interiors',    40),
  ('aprovacoes',        'Aprovações e Trâmites',  'approval',     50),
  ('b2b_desenvolvimento','B2B / Desenvolvimento', 'development',  60),
  ('obra',              'Obra',                   'construction', 70);

-- -----------------------------------------------------------------------------
-- Serviços
-- Disponibilidade B2C/B2B: valores explicitamente definidos pela YouCon para
-- Estrutural, Elétrico, Hidrossanitário, SPDA, Combate a Incêndio, Estudo de
-- Viabilidade e Projeto Executivo. Demais serviços iniciam disponíveis para
-- ambos e devem ser revisados no Gerenciador de Templates.
-- -----------------------------------------------------------------------------
with f as (select id, code from public.service_families)
insert into public.services (family_id, code, name, available_for_b2c, available_for_b2b, requires_area_rule, sort_order, aliases)
select f.id, s.code, s.name, s.b2c, s.b2b, s.area, s.ord, s.aliases
from (values
  ('arquitetura',  'projeto_arquitetonico',        'Projeto Arquitetônico',            true,  true,  false, 10, '{"Arquitetura","Projeto de Arquitetura"}'::text[]),
  ('engenharia',   'projeto_estrutural',           'Projeto Estrutural',               true,  true,  false, 10, '{"Estrutural"}'),
  ('engenharia',   'projeto_eletrico',             'Projeto Elétrico',                 true,  true,  false, 20, '{"Elétrico","Eletrico"}'),
  ('engenharia',   'projeto_hidrossanitario',      'Projeto Hidrossanitário',          true,  true,  false, 30, '{"Hidrossanitário","Hidrossanitario","Hidráulico"}'),
  ('engenharia',   'combate_incendio',             'Combate a Incêndio',               false, true,  false, 40, '{"PPCI","Incêndio"}'),
  ('engenharia',   'telecomunicacao',              'Telecomunicação',                  true,  true,  false, 50, '{"Telecom"}'),
  ('engenharia',   'climatizacao',                 'Climatização',                     true,  true,  false, 60, '{"HVAC","Ar-condicionado"}'),
  ('engenharia',   'instalacoes_gas',              'Instalações de Gás',               true,  true,  false, 70, '{"Gás"}'),
  ('engenharia',   'spda',                         'SPDA',                             false, true,  false, 80, '{"Para-raios"}'),
  ('orcamentos',   'orcamento_estimativo',         'Orçamento Estimativo',             true,  true,  false, 10, '{}'),
  ('orcamentos',   'orcamento_detalhado',          'Orçamento Detalhado',              true,  true,  false, 20, '{}'),
  ('interiores',   'design_interiores',            'Design de Interiores',             true,  true,  true,  10, '{"Interiores","Projeto de Interiores"}'),
  ('interiores',   'assessoria_interiores',        'Assessoria de Interiores',         true,  true,  false, 20, '{}'),
  ('aprovacoes',   'aprovacao_projeto_legal',      'Aprovação / Projeto Legal',        true,  true,  false, 10, '{"Aprovação","Projeto Legal"}'),
  ('aprovacoes',   'tramites_financiamento',       'Trâmites de Financiamento',        true,  true,  false, 20, '{}'),
  ('aprovacoes',   'tramites_vigilancia_sanitaria','Trâmites de Vigilância Sanitária', true,  true,  false, 30, '{"Vigilância Sanitária"}'),
  ('b2b_desenvolvimento','estudo_viabilidade',     'Estudo de Viabilidade',            false, true,  false, 10, '{}'),
  ('b2b_desenvolvimento','projeto_executivo',      'Projeto Executivo',                false, true,  false, 20, '{}'),
  ('obra',         'gestao_obra_integrada',        'Gestão de Obra Integrada',         true,  true,  false, 10, '{"Gestão de Obra"}')
) as s(family, code, name, b2c, b2b, area, ord, aliases)
join f on f.code = s.family;

-- Pacote comercial: o CRM pode enviar "Projetos Complementares" e a plataforma expande.
insert into public.service_packages (code, name, description, aliases)
values ('projetos_complementares', 'Projetos Complementares', 'Elétrico + Hidrossanitário', '{"Complementares"}');
insert into public.package_services (package_id, service_id)
select p.id, s.id from public.service_packages p, public.services s
where p.code = 'projetos_complementares' and s.code in ('projeto_eletrico', 'projeto_hidrossanitario');

-- -----------------------------------------------------------------------------
-- Templates v1 — helper temporário
-- tasks: [{code,name,days,type,include_if:[...],dep:"service.task"}]
-- Cada etapa depende da anterior (término → início). "dep" adiciona dependência
-- entre serviços, ignorada quando o serviço predecessor não foi contratado.
-- -----------------------------------------------------------------------------
create function pg_temp.seed_template(p_service text, p_name text, p_area_min numeric, p_area_max numeric, p_tasks jsonb)
returns void language plpgsql as $$
declare
  v_template uuid;
  v_prev uuid;
  v_task uuid;
  t jsonb;
  i int := 0;
begin
  insert into public.schedule_templates (service_id, name, version, area_min, area_max, status, notes)
  select id, p_name, 1, p_area_min, p_area_max, 'draft', 'Versão inicial — padrão YouCon'
  from public.services where code = p_service
  returning id into v_template;

  for t in select * from jsonb_array_elements(p_tasks) loop
    i := i + 1;
    insert into public.template_tasks (template_id, code, name, sort_order, default_duration_days, duration_type, include_if_service_codes)
    values (v_template, t->>'code', t->>'name', i * 10, (t->>'days')::int,
            coalesce(t->>'type', 'fixed')::public.duration_type,
            case when t ? 'include_if' then array(select jsonb_array_elements_text(t->'include_if')) end)
    returning id into v_task;

    if v_prev is not null then
      insert into public.template_task_dependencies (template_task_id, predecessor_task_id) values (v_task, v_prev);
    end if;
    if t ? 'dep' then
      insert into public.template_task_dependencies (template_task_id, predecessor_service_code, predecessor_task_code, optional_if_missing)
      values (v_task, split_part(t->>'dep', '.', 1), split_part(t->>'dep', '.', 2), true);
    end if;
    v_prev := v_task;
  end loop;

  update public.schedule_templates set status = 'published', active = true, published_at = now() where id = v_template;
end;
$$;

-- Projeto Arquitetônico
select pg_temp.seed_template('projeto_arquitetonico', 'Projeto Arquitetônico', null, null, '[
  {"code":"planejamento",       "name":"Planejamento",       "days":20},
  {"code":"envio_briefing",     "name":"Envio do Briefing",  "days":7},
  {"code":"estudo_preliminar",  "name":"Estudo Preliminar",  "days":20},
  {"code":"alteracoes",         "name":"Alterações",         "days":30},
  {"code":"imagens_3d_video",   "name":"Imagens 3D e Vídeo", "days":10}
]');

-- Aprovação / Projeto Legal
select pg_temp.seed_template('aprovacao_projeto_legal', 'Aprovação / Projeto Legal', null, null, '[
  {"code":"planejamento_arquitetura", "name":"Planejamento com Arquitetura",        "days":20},
  {"code":"briefing_arq_apr_eng",     "name":"Briefing Arq + Apr + Eng",            "days":3},
  {"code":"producao_arquitetura",     "name":"Tempo de Produção da Arquitetura",    "type":"dependent", "dep":"projeto_arquitetonico.estudo_preliminar"},
  {"code":"revisao_apr_arq_eng",      "name":"Revisão APR x ARQ x ENG",             "days":2},
  {"code":"planejamento",             "name":"Planejamento",                        "days":15},
  {"code":"projeto_legal",            "name":"Projeto Legal",                       "days":10},
  {"code":"verificacao",              "name":"Verificação",                         "days":3},
  {"code":"protocolo",                "name":"Protocolo Condomínio ou Prefeitura",  "days":2},
  {"code":"aprovacao_alvara",         "name":"Aprovação ou Alvará",                 "type":"external"}
]');

-- Engenharia — template base aplicado a cada disciplina. Etapas 6–9 sem prazo
-- fornecido: duração "a definir", configurável por serviço.
do $$
declare s record;
begin
  for s in select code, name from public.services
           where family_id = (select id from public.service_families where code = 'engenharia')
  loop
    perform pg_temp.seed_template(s.code, s.name, null, null, '[
      {"code":"briefing_arq_apr_eng",        "name":"Briefing Arq + Apr + Eng",          "days":3},
      {"code":"producao_arquitetura",        "name":"Tempo de Produção da Arquitetura",  "type":"dependent", "dep":"projeto_arquitetonico.estudo_preliminar"},
      {"code":"revisao_apr_arq_eng",         "name":"Revisão APR x ARQ x ENG",           "days":2},
      {"code":"orcamento_estimativo",        "name":"Orçamento Estimativo",              "days":5, "include_if":["orcamento_estimativo"]},
      {"code":"planejamento",                "name":"Planejamento",                      "days":10},
      {"code":"producao_disciplina",         "name":"Produção da disciplina"},
      {"code":"compatibilizacao",            "name":"Compatibilização"},
      {"code":"executivo",                   "name":"Executivo"},
      {"code":"compatibilizacao_interiores", "name":"Compatibilização para interiores",  "include_if":["design_interiores","assessoria_interiores"]}
    ]'::jsonb);
  end loop;
end $$;

-- Design de Interiores — até 500 m²
select pg_temp.seed_template('design_interiores', 'Design de Interiores — até 500 m²', null, 500, '[
  {"code":"planejamento",       "name":"Planejamento",           "days":10},
  {"code":"envio_briefing",     "name":"Envio do Briefing",      "days":5},
  {"code":"projeto_interiores", "name":"Projeto de Interiores",  "days":10},
  {"code":"alteracao",          "name":"Alteração",              "days":15},
  {"code":"renderizacao",       "name":"Renderização",           "days":10},
  {"code":"detalhamento",       "name":"Detalhamento",           "days":15},
  {"code":"assessoria",         "name":"Assessoria",             "days":5}
]');

-- Design de Interiores — acima de 500 m²
select pg_temp.seed_template('design_interiores', 'Design de Interiores — acima de 500 m²', 500, null, '[
  {"code":"planejamento",       "name":"Planejamento",       "days":15},
  {"code":"envio_briefing",     "name":"Envio do Briefing",  "days":7},
  {"code":"layout_modelagem",   "name":"Layout + Modelagem", "days":15},
  {"code":"alteracao",          "name":"Alteração",          "days":20},
  {"code":"renderizacao",       "name":"Renderização",       "days":15},
  {"code":"detalhamento",       "name":"Detalhamento",       "days":20},
  {"code":"assessoria",         "name":"Assessoria",         "days":10}
]');

-- Gestão de Obra Integrada
select pg_temp.seed_template('gestao_obra_integrada', 'Gestão de Obra Integrada', null, null, '[
  {"code":"orcamento_detalhado",    "name":"Orçamento Detalhado",          "days":30},
  {"code":"cronograma_fisico_fin",  "name":"Cronograma Físico-financeiro", "days":15},
  {"code":"gestao_obra",            "name":"Gestão de Obra",               "type":"ongoing"}
]');

