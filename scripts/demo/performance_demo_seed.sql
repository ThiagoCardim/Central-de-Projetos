-- Dados FICTÍCIOS de demonstração (performance, tarefas, agenda).
-- Tudo marcado: clientes/projetos com external_source = 'demo' e nome "DEMO · ...";
-- tarefas da liderança com título terminando em " (demo)".
do $$
declare
  cfg jsonb := '[
    {"p":"5956640e-18c7-48c5-9aa9-c46269d011f1","s":"arquitetura","d":0.97,"t":0.90,"v":9,"lead":"7b4df631-b927-4c31-b88f-f1f37ae3fc5b"},
    {"p":"eff56117-7097-4195-af5a-1ab2bc3fc185","s":"arquitetura","d":0.90,"t":0.70,"v":8,"lead":"7b4df631-b927-4c31-b88f-f1f37ae3fc5b"},
    {"p":"7b4df631-b927-4c31-b88f-f1f37ae3fc5b","s":"arquitetura","d":0.95,"t":0.85,"v":4,"lead":null},
    {"p":"b8c96150-608d-41ad-8b25-b57162600099","s":"engenharia","d":0.86,"t":0.74,"v":10,"lead":"47752b90-ab7d-4b79-9b8d-7b6021b9306a"},
    {"p":"edface53-e2c2-44d2-aef2-e1012b7f93df","s":"engenharia","d":0.97,"t":0.93,"v":9,"lead":"47752b90-ab7d-4b79-9b8d-7b6021b9306a"},
    {"p":"de26ce71-c126-49d8-bd35-941de1ad0b66","s":"engenharia","d":0.70,"t":0.50,"v":8,"lead":"47752b90-ab7d-4b79-9b8d-7b6021b9306a"},
    {"p":"47752b90-ab7d-4b79-9b8d-7b6021b9306a","s":"engenharia","d":0.92,"t":0.80,"v":4,"lead":null},
    {"p":"1ba53448-e91f-4a4c-8f8e-1bd8109347a7","s":"interiores","d":0.98,"t":0.93,"v":9,"lead":"7861b530-caae-4b2a-adf1-e2ed9c8b3369"},
    {"p":"3ea086bc-84df-441f-87e6-35c4f131ab66","s":"interiores","d":0.88,"t":0.75,"v":7,"lead":"7861b530-caae-4b2a-adf1-e2ed9c8b3369"},
    {"p":"7861b530-caae-4b2a-adf1-e2ed9c8b3369","s":"interiores","d":0.90,"t":0.80,"v":4,"lead":null},
    {"p":"98a9de2b-82f3-4f41-a354-7ac4631f4e8b","s":"aprovacoes","d":0.72,"t":0.55,"v":8,"lead":"7861b530-caae-4b2a-adf1-e2ed9c8b3369"},
    {"p":"2a7d25f3-cf9e-40dc-b15b-5ab36fcb2aba","s":"aprovacoes","d":0.95,"t":0.90,"v":9,"lead":"7861b530-caae-4b2a-adf1-e2ed9c8b3369"},
    {"p":"67507e7e-1857-49d4-a1a9-728bf438294b","s":"engenharia","d":0.90,"t":0.80,"v":4,"lead":null},
    {"p":"fc986577-206a-46bf-87c7-dbc4dff33365","s":"engenharia","d":0.85,"t":0.70,"v":8,"lead":"67507e7e-1857-49d4-a1a9-728bf438294b"},
    {"p":"7f3d36de-f543-4b97-a8b3-75524585c573","s":"interiores","d":0.93,"t":0.85,"v":8,"lead":"67507e7e-1857-49d4-a1a9-728bf438294b"},
    {"p":"25a3a6f7-00a1-449d-8483-2ec616b97882","s":"arquitetura","d":0.92,"t":0.85,"v":4,"lead":null},
    {"p":"9e813ee6-b794-4896-9048-50a5d462b46f","s":"arquitetura","d":0.80,"t":0.65,"v":8,"lead":"25a3a6f7-00a1-449d-8483-2ec616b97882"},
    {"p":"54a77dbb-eade-43d2-99bf-427558c269fc","s":"engenharia","d":0.88,"t":0.78,"v":8,"lead":"25a3a6f7-00a1-449d-8483-2ec616b97882"}
  ]';
  acts jsonb := '{
    "arquitetura": [["Planejamento","projeto_arquitetonico"],["Envio do Briefing","projeto_arquitetonico"],["Estudo Preliminar","projeto_arquitetonico"],["Revisões","projeto_arquitetonico"],["Renderização","projeto_arquitetonico"],["Vídeo","projeto_arquitetonico"],["Projeto Finalizado","projeto_arquitetonico"]],
    "engenharia": [["Projeto Estrutural","projeto_estrutural"],["Compatibilização Estrutural","projeto_estrutural"],["Projeto Elétrico","projeto_eletrico"],["Projeto Hidrossanitário","projeto_hidrossanitario"],["Compatibilização complementares","projeto_hidrossanitario"],["Correção de projeto","projeto_estrutural"],["Relatório de Obras","projeto_estrutural"]],
    "interiores": [["Planejamento","design_interiores"],["Briefing","design_interiores"],["Estudo Preliminar","design_interiores"],["Revisões","design_interiores"],["Renderização","design_interiores"],["Detalhamento","design_interiores"],["Assessoria","design_interiores"]],
    "aprovacoes": [["Planejamento","aprovacao_projeto_legal"],["PL Finalizado","aprovacao_projeto_legal"],["Protocolo PL","aprovacao_projeto_legal"],["Correções PL","aprovacao_projeto_legal"],["Aprovação em Condomínio","aprovacao_projeto_legal"],["Alvará","aprovacao_projeto_legal"]]
  }';
  tasks_titles text[] := array['Atualizar memorial descritivo','Organizar pranchas no servidor','Revisar checklist de entrega','Levantamento fotográfico do terreno',
    'Conferir quantitativos','Enviar ART para assinatura','Responder cliente sobre ajustes','Preparar apresentação de projeto','Atualizar cronograma do cliente',
    'Revisar padrão de carimbo','Conferir medidas in loco','Separar referências de acabamento'];
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  c jsonb; a jsonb; v_list jsonb;
  v_tenant uuid; v_client uuid; v_proj uuid; v_ps uuid; v_tr uuid;
  v_projects uuid[]; v_name text; v_svc text;
  m int; k int; n int;
  v_m0 date; v_m1 date; v_due date; v_start date; v_end date; v_status public.task_status; v_act_start date;
  v_seq int := 1000;
  r double precision;
  pnames text[] := array['Residência Aurora','Casa Jardins','Edifício Horizonte Sul','Clínica Bem-Estar'];
begin
  perform setseed(0.4242);

  -- Setores
  for c in select * from jsonb_array_elements(cfg) loop
    update public.profiles p set sector_id = (select x.id from public.sectors x where x.tenant_id = p.tenant_id and x.archived_at is null
        and x.name = case c ->> 's' when 'arquitetura' then 'Arquitetura' when 'engenharia' then 'Engenharia' when 'interiores' then 'Interiores' else 'Aprovação' end)
     where p.id = (c ->> 'p')::uuid;
  end loop;

  -- Cliente e projetos de demonstração por unidade
  for v_tenant in select distinct p.tenant_id from public.profiles p where p.id in (select (x ->> 'p')::uuid from jsonb_array_elements(cfg) x) loop
    insert into public.clients (tenant_id, name, client_type, external_source, external_id)
    values (v_tenant, 'Cliente Demonstração (fictício)', 'b2c', 'demo', 'demo-' || v_tenant) returning id into v_client;
    for k in 1 .. array_length(pnames, 1) loop
      insert into public.projects (client_id, name, client_type, commercial_tenant_id, delivery_tenant_id, status, started_at, external_source, external_id)
      values (v_client, 'DEMO · ' || pnames[k], 'b2c', v_tenant, v_tenant, 'in_progress', now() - interval '6 months', 'demo', 'demo-' || v_tenant || '-' || k)
      returning id into v_proj;
      for v_svc in select unnest(array['projeto_arquitetonico','projeto_estrutural','projeto_eletrico','projeto_hidrossanitario','design_interiores','aprovacao_projeto_legal']) loop
        insert into public.project_services (project_id, service_id) values (v_proj, (select id from public.services where code = v_svc)) returning id into v_ps;
        insert into public.project_schedule_tracks (project_id, project_service_id, status) values (v_proj, v_ps, 'in_progress');
      end loop;
    end loop;
  end loop;

  -- Etapas por pessoa nos últimos 6 meses (e próximas semanas)
  for c in select * from jsonb_array_elements(cfg) loop
    select tenant_id into v_tenant from public.profiles where id = (c ->> 'p')::uuid;
    select array_agg(id) into v_projects from public.projects where external_source = 'demo' and delivery_tenant_id = v_tenant;
    v_list := acts -> (c ->> 's');
    for m in 0 .. 5 loop
      v_m0 := (date_trunc('month', v_today) - make_interval(months => m))::date;
      v_m1 := (v_m0 + interval '1 month - 1 day')::date;
      n := (c ->> 'v')::int + floor(random() * 4)::int - 1;
      for k in 1 .. n loop
        a := v_list -> floor(random() * jsonb_array_length(v_list))::int;
        v_name := a ->> 0;
        v_proj := v_projects[1 + floor(random() * array_length(v_projects, 1))::int];
        select tr.id into v_tr from public.project_schedule_tracks tr join public.project_services ps on ps.id = tr.project_service_id
          join public.services s on s.id = ps.service_id where tr.project_id = v_proj and s.code = a ->> 1;
        v_due := v_m0 + floor(random() * (v_m1 - v_m0 + 1))::int;
        if extract(isodow from v_due) = 6 then v_due := v_due - 1; elsif extract(isodow from v_due) = 7 then v_due := v_due + 1; end if;
        v_start := v_due - (2 + floor(random() * 9))::int;
        v_end := null; v_act_start := null;
        if v_due < v_today then
          r := random();
          if r < (c ->> 'd')::float or m >= 2 then
            v_status := 'completed';
            if random() < (c ->> 't')::float then v_end := v_due - floor(random() * 3)::int;
            else v_end := v_due + (1 + floor(random() * (case when m >= 2 and r >= (c ->> 'd')::float then 12 else 5 end)))::int; end if;
            v_end := least(v_end, v_today);
            v_act_start := least(v_start, v_end);
          else
            v_status := 'in_progress'; v_act_start := least(v_start, v_today);
          end if;
        elsif v_start <= v_today then
          v_status := 'in_progress'; v_act_start := v_start;
        else
          v_status := 'not_started';
        end if;
        v_seq := v_seq + 1;
        insert into public.project_tasks (schedule_track_id, project_id, name, sequence, duration_type, planned_duration_days,
                                          planned_start_date, planned_end_date, actual_start_date, actual_end_date, status, responsible_user_id, client_visible)
        values (v_tr, v_proj, v_name, v_seq, 'fixed', greatest(1, v_due - v_start), v_start, v_due, v_act_start, v_end, v_status, (c ->> 'p')::uuid, false);
      end loop;
    end loop;

    -- Tarefas da liderança (passado, hoje e próximos dias)
    if c ->> 'lead' is not null then
      for m in 0 .. 5 loop
        v_m0 := (date_trunc('month', v_today) - make_interval(months => m))::date;
        v_m1 := least((v_m0 + interval '1 month - 1 day')::date, v_today - 1);
        for k in 1 .. 2 + floor(random() * 3)::int loop
          exit when v_m1 < v_m0;
          v_due := v_m0 + floor(random() * (v_m1 - v_m0 + 1))::int;
          r := random();
          insert into public.work_items (owner_id, title, due_date, done_at, assigned_by, assigned_at, created_at)
          values ((c ->> 'p')::uuid, tasks_titles[1 + floor(random() * array_length(tasks_titles, 1))::int] || ' (demo)', v_due,
                  case when r < (c ->> 'd')::float or m >= 1 then
                    ((least(v_today, v_due + case when random() < (c ->> 't')::float then 0 else (1 + floor(random() * 4))::int end)) + time '15:00') at time zone 'America/Sao_Paulo' end,
                  (c ->> 'lead')::uuid, now() - interval '10 days', now() - interval '10 days');
        end loop;
      end loop;
      -- Hoje e próximos dias
      insert into public.work_items (owner_id, title, due_date, assigned_by, assigned_at)
      select (c ->> 'p')::uuid, tasks_titles[1 + floor(random() * array_length(tasks_titles, 1))::int] || ' (demo)', v_today + d, (c ->> 'lead')::uuid, now()
      from unnest(array[0, 1, 3]) d;
    end if;
  end loop;
end $$;
