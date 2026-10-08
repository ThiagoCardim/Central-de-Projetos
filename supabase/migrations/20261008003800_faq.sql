-- =============================================================================
-- 0038 · Dúvidas frequentes (FAQ) para o cliente
--
--   * Categorias e perguntas do FAQ YouCon (173 perguntas em 16 categorias),
--     visíveis para todos os usuários (inclusive clientes).
--   * Edição pela administração global (Configurações › FAQ): perguntas,
--     respostas, palavras-chave e categorias. Exclusão é lógica (arquiva).
--   * Retorno do leitor ("Isso respondeu sua dúvida?") guardado para a
--     administração ver o que não está sendo respondido.
-- =============================================================================

create table public.faq_categories (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) between 2 and 80),
  sort_order  int not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger faq_categories_touch before update on public.faq_categories for each row execute function private.touch_updated_at();

create table public.faq_items (
  id          uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.faq_categories (id),
  question    text not null check (length(trim(question)) between 5 and 300),
  answer      text not null check (length(trim(answer)) between 2 and 8000),
  keywords    text check (keywords is null or length(keywords) <= 500),
  sort_order  int not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null
);
create index faq_items_category_idx on public.faq_items (category_id, sort_order);
create trigger faq_items_touch before update on public.faq_items for each row execute function private.touch_updated_at();

create table public.faq_feedback (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid references public.faq_items (id),
  helpful    boolean not null,
  query      text check (query is null or length(query) <= 300),
  profile_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index faq_feedback_item_idx on public.faq_feedback (item_id);

alter table public.faq_categories enable row level security;
alter table public.faq_items enable row level security;
alter table public.faq_feedback enable row level security;
create policy faq_categories_select on public.faq_categories for select to authenticated
  using (archived_at is null or private.can_manage_tenants());
create policy faq_items_select on public.faq_items for select to authenticated
  using (archived_at is null or private.can_manage_tenants());
create policy faq_feedback_select on public.faq_feedback for select to authenticated using (private.can_manage_tenants());
revoke all on public.faq_categories, public.faq_items, public.faq_feedback from anon;
grant select on public.faq_categories, public.faq_items, public.faq_feedback to authenticated;

-- Edição (ADM global)
create or replace function private.faq_category_save(p_id uuid, p_title text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if not private.can_manage_tenants() then raise exception 'Só a administração global edita o FAQ' using errcode = '42501'; end if;
  if length(trim(coalesce(p_title, ''))) < 2 then raise exception 'Informe o nome da categoria' using errcode = '23514'; end if;
  if p_id is null then
    insert into public.faq_categories (title, sort_order)
    values (trim(p_title), coalesce((select max(sort_order) from public.faq_categories), 0) + 10) returning id into v_id;
  else
    update public.faq_categories set title = trim(p_title), archived_at = null where id = p_id returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function private.faq_category_archive(p_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_tenants() then raise exception 'Só a administração global edita o FAQ' using errcode = '42501'; end if;
  if exists (select 1 from public.faq_items where category_id = p_id and archived_at is null) then
    raise exception 'Mova ou exclua as perguntas desta categoria antes de excluí-la' using errcode = '23514';
  end if;
  update public.faq_categories set archived_at = now() where id = p_id;
end;
$$;

create or replace function private.faq_item_save(p_id uuid, p_category uuid, p_question text, p_answer text, p_keywords text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if not private.can_manage_tenants() then raise exception 'Só a administração global edita o FAQ' using errcode = '42501'; end if;
  if not exists (select 1 from public.faq_categories where id = p_category and archived_at is null) then
    raise exception 'Categoria inválida' using errcode = '23514';
  end if;
  if length(trim(coalesce(p_question, ''))) < 5 then raise exception 'Escreva a pergunta' using errcode = '23514'; end if;
  if length(trim(coalesce(p_answer, ''))) < 2 then raise exception 'Escreva a resposta' using errcode = '23514'; end if;
  if p_id is null then
    insert into public.faq_items (category_id, question, answer, keywords, sort_order, updated_by)
    values (p_category, trim(p_question), trim(p_answer), nullif(trim(p_keywords), ''),
            coalesce((select max(sort_order) from public.faq_items where category_id = p_category), 0) + 10, private.current_profile_id())
    returning id into v_id;
  else
    update public.faq_items set category_id = p_category, question = trim(p_question), answer = trim(p_answer),
      keywords = nullif(trim(p_keywords), ''), archived_at = null, updated_by = private.current_profile_id()
     where id = p_id returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function private.faq_item_archive(p_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_tenants() then raise exception 'Só a administração global edita o FAQ' using errcode = '42501'; end if;
  update public.faq_items set archived_at = now(), updated_by = private.current_profile_id() where id = p_id;
end;
$$;

-- "Isso respondeu sua dúvida?" (qualquer usuário)
create or replace function private.faq_feedback_add(p_item uuid, p_helpful boolean, p_query text) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if private.current_profile_id() is null then raise exception 'Sem permissão' using errcode = '42501'; end if;
  insert into public.faq_feedback (item_id, helpful, query, profile_id)
  values (p_item, coalesce(p_helpful, false), left(nullif(trim(p_query), ''), 300), private.current_profile_id());
end;
$$;

create or replace function public.faq_category_save(p_id uuid, p_title text) returns uuid
language sql security invoker set search_path = '' as $$ select private.faq_category_save(p_id, p_title) $$;
create or replace function public.faq_category_archive(p_id uuid) returns void
language sql security invoker set search_path = '' as $$ select private.faq_category_archive(p_id) $$;
create or replace function public.faq_item_save(p_id uuid, p_category uuid, p_question text, p_answer text, p_keywords text) returns uuid
language sql security invoker set search_path = '' as $$ select private.faq_item_save(p_id, p_category, p_question, p_answer, p_keywords) $$;
create or replace function public.faq_item_archive(p_id uuid) returns void
language sql security invoker set search_path = '' as $$ select private.faq_item_archive(p_id) $$;
create or replace function public.faq_feedback_add(p_item uuid, p_helpful boolean, p_query text) returns void
language sql security invoker set search_path = '' as $$ select private.faq_feedback_add(p_item, p_helpful, p_query) $$;

revoke all on function private.faq_category_save(uuid, text), private.faq_category_archive(uuid), private.faq_item_save(uuid, uuid, text, text, text),
  private.faq_item_archive(uuid), private.faq_feedback_add(uuid, boolean, text),
  public.faq_category_save(uuid, text), public.faq_category_archive(uuid), public.faq_item_save(uuid, uuid, text, text, text),
  public.faq_item_archive(uuid), public.faq_feedback_add(uuid, boolean, text) from public, anon;
grant execute on function private.faq_category_save(uuid, text), private.faq_category_archive(uuid), private.faq_item_save(uuid, uuid, text, text, text),
  private.faq_item_archive(uuid), private.faq_feedback_add(uuid, boolean, text),
  public.faq_category_save(uuid, text), public.faq_category_archive(uuid), public.faq_item_save(uuid, uuid, text, text, text),
  public.faq_item_archive(uuid), public.faq_feedback_add(uuid, boolean, text) to authenticated;

-- Conteúdo inicial (FAQ YouCon)
insert into public.faq_categories (title, sort_order) values
  ($faq$Documentação do Imóvel$faq$, 10),
  ($faq$Arquitetura e Implantação$faq$, 20),
  ($faq$Matrícula, Terreno e Regularização$faq$, 30),
  ($faq$Levantamento e Características do Terreno$faq$, 40),
  ($faq$Projeto e Compatibilização$faq$, 50),
  ($faq$Sondagem e Engenharia$faq$, 60),
  ($faq$Responsabilidade Técnica — RT, ART e RRT$faq$, 70),
  ($faq$Processo de Aprovação$faq$, 80),
  ($faq$Taxas e Custos$faq$, 90),
  ($faq$Prazos$faq$, 100),
  ($faq$Alterações e Atualizações$faq$, 110),
  ($faq$Situações Especiais do Imóvel$faq$, 120),
  ($faq$Documentos e Processos Digitais$faq$, 130),
  ($faq$Conferência e Prevenção de Retrabalho$faq$, 140),
  ($faq$Responsabilidades do Cliente e da Equipe$faq$, 150),
  ($faq$Como o Cliente Pode Contribuir para o Andamento$faq$, 160);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 10 and archived_at is null), q, a, o from (values
  ($faq$O que é uma matrícula?$faq$, $faq$É o documento que individualiza juridicamente o imóvel no Cartório de Registro de Imóveis. Nela constam informações como proprietário, área, medidas, confrontações, localização e eventuais registros e averbações relacionados ao imóvel.

A matrícula funciona como uma das principais referências documentais utilizadas para compreender a situação jurídica do imóvel.$faq$, 10),
  ($faq$O que é uma matrícula atualizada?$faq$, $faq$É a matrícula que representa a situação mais recente registrada para o imóvel. A atualização é importante porque podem ter ocorrido alterações desde a emissão de uma matrícula anterior, como mudança de proprietário, averbação de construção, alteração de área, desmembramento, unificação ou outros registros.

Por isso, não devemos considerar automaticamente que uma matrícula antiga representa a situação atual do imóvel.$faq$, 20),
  ($faq$Qual a diferença entre matrícula e certidão de matrícula?$faq$, $faq$A matrícula é o registro individual do imóvel mantido pelo Cartório de Registro de Imóveis.

A certidão de matrícula é o documento emitido pelo cartório que reproduz ou certifica as informações constantes desse registro, conforme o tipo de certidão solicitada.

Em processos de aprovação, é importante verificar qual documento o órgão responsável está exigindo e qual a data de emissão aceita.$faq$, 30),
  ($faq$O que é uma certidão?$faq$, $faq$É um documento oficial emitido por um órgão público ou entidade competente que atesta determinada informação ou situação.

A certidão pode ser utilizada para comprovar, por exemplo, a situação de um imóvel, a existência ou inexistência de débitos ou determinada informação cadastral.$faq$, 40),
  ($faq$O que é uma CND?$faq$, $faq$CND significa Certidão Negativa de Débitos. É um documento utilizado para comprovar a inexistência de determinados débitos perante o órgão ou entidade responsável pela emissão.

Importante observar que existem diferentes tipos de certidões e diferentes órgãos emissores. Portanto, a CND solicitada deve ser analisada de acordo com o processo específico.$faq$, 50),
  ($faq$O que é um contrato de compra e venda?$faq$, $faq$É o instrumento que formaliza o acordo entre comprador e vendedor para a compra e venda de um imóvel. Nele podem constar informações como partes envolvidas, valor, forma de pagamento, condições da negociação e demais obrigações estabelecidas entre as partes.

Importante: o contrato de compra e venda, por si só, não substitui a matrícula nem significa que o comprador já consta como proprietário perante o Registro de Imóveis.$faq$, 60),
  ($faq$Qual a diferença entre matrícula, certidão e contrato de compra e venda?$faq$, $faq$- Matrícula: identifica juridicamente o imóvel e registra sua situação perante o Cartório de Registro de Imóveis.
- Certidão: comprova oficialmente determinada informação ou situação perante o órgão que a emitiu.
- Contrato de compra e venda: formaliza o acordo entre comprador e vendedor.

Cada documento possui uma finalidade diferente e, por isso, um não deve ser utilizado automaticamente como substituto do outro.$faq$, 70),
  ($faq$O que é a inscrição imobiliária?$faq$, $faq$É o número utilizado pelo município para identificar o imóvel em seu cadastro imobiliário. Ela está relacionada ao cadastro municipal e pode ser utilizada para consultar informações como localização, identificação cadastral e dados tributários do imóvel.

A inscrição imobiliária não substitui a matrícula, pois cada documento possui uma finalidade diferente.$faq$, 80),
  ($faq$O que é IPTU e por que ele pode ser solicitado?$faq$, $faq$O IPTU é o Imposto Predial e Territorial Urbano, cobrado pelo município.

Documentos relacionados ao IPTU podem ser utilizados para conferir informações cadastrais do imóvel, como inscrição imobiliária, endereço e dados utilizados pelo município.

A necessidade desse documento depende do processo e das exigências do órgão responsável.$faq$, 90),
  ($faq$Por que preciso fornecer tantos documentos?$faq$, $faq$Os documentos permitem que a equipe conheça a situação documental, cadastral e física do imóvel antes do desenvolvimento do projeto e do início da aprovação.

Cada documento possui uma finalidade específica. Alguns confirmam informações do imóvel, outros verificam sua situação perante o município ou outros órgãos e alguns são necessários para atender às exigências do processo.

A documentação também permite identificar possíveis divergências antes do protocolo, evitando retrabalho e atrasos. Quanto mais completas e consistentes forem as informações fornecidas no início, maior a segurança para desenvolver e aprovar o projeto.$faq$, 100),
  ($faq$Preciso enviar todos os documentos antes de começar o projeto?$faq$, $faq$A documentação necessária pode variar conforme o tipo de projeto, as características do imóvel e o processo que será realizado. Alguns documentos são fundamentais para iniciar o desenvolvimento, enquanto outros podem ser necessários em etapas posteriores.

A equipe orientará quais documentos são necessários para cada etapa.$faq$, 110),
  ($faq$Se o imóvel tiver mais de um proprietário, há algum cuidado adicional?$faq$, $faq$Sim. A documentação deve refletir corretamente quem são os proprietários e, quando necessário, deve-se verificar quem possui legitimidade para assinar documentos, autorizar o projeto ou representar os demais.

A necessidade de procuração ou de assinatura dos demais proprietários depende do procedimento e das exigências aplicáveis.$faq$, 120)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 20 and archived_at is null), q, a, o from (values
  ($faq$O que é estudo de viabilidade?$faq$, $faq$É a análise inicial realizada para verificar se determinada proposta é tecnicamente, legalmente e, conforme o escopo contratado, operacionalmente possível para o imóvel. Pode envolver a análise de documentação, legislação, parâmetros urbanísticos, características do terreno, restrições e necessidades do cliente.

O estudo de viabilidade ajuda a identificar condicionantes antes do desenvolvimento completo do projeto.$faq$, 130),
  ($faq$O que é estudo preliminar?$faq$, $faq$É uma etapa inicial do desenvolvimento arquitetônico em que são estudadas alternativas de implantação, organização dos ambientes, volumetria e demais características principais da edificação.

O estudo preliminar permite avaliar e definir a solução que será desenvolvida nas etapas seguintes.$faq$, 140),
  ($faq$O que é um projeto arquitetônico?$faq$, $faq$É o conjunto de informações técnicas que representa e define a edificação, incluindo sua organização, ambientes, dimensões, implantação, acessos, aberturas e demais características necessárias ao desenvolvimento da construção.

Além de atender às necessidades do cliente, o projeto precisa considerar as características do terreno, a legislação aplicável e sua compatibilização com os demais projetos.$faq$, 150),
  ($faq$O que é implantação?$faq$, $faq$É a representação de como a edificação será posicionada dentro do terreno. A implantação considera elementos como limites do lote, recuos, acessos, orientação, níveis, topografia, edificações existentes, áreas permeáveis e demais parâmetros aplicáveis.

Por isso, a posição da construção não é definida apenas pela preferência do proprietário.$faq$, 160),
  ($faq$O que são parâmetros urbanísticos?$faq$, $faq$São regras que determinam como determinado terreno pode ser ocupado e utilizado.

Podem envolver, por exemplo:

- uso permitido;
- recuos;
- taxa de ocupação;
- coeficiente de aproveitamento;
- altura;
- número de pavimentos;
- área permeável;
- afastamentos;
- outras condições específicas.$faq$, 170),
  ($faq$O que é uso e ocupação do solo?$faq$, $faq$É o conjunto de regras que determina quais atividades podem ser realizadas em determinado local e de que forma o terreno pode ser ocupado.

Por isso, antes de desenvolver uma edificação, é necessário verificar se o uso pretendido e sua implantação são permitidos para aquele imóvel.$faq$, 180),
  ($faq$Como sabemos se posso construir determinado tipo de edificação no meu terreno?$faq$, $faq$É necessário analisar a localização do imóvel, seu zoneamento, o uso pretendido, os parâmetros urbanísticos, as características do lote, eventuais restrições e as exigências dos órgãos envolvidos.

A possibilidade de construção não deve ser presumida apenas com base no tamanho do terreno.$faq$, 190),
  ($faq$O que são recuos?$faq$, $faq$São as distâncias mínimas que devem ser respeitadas entre a edificação e os limites do terreno, conforme as regras aplicáveis ao imóvel. Os recuos podem variar conforme localização, zoneamento, uso da edificação, altura e demais características previstas na legislação.$faq$, 200),
  ($faq$O que é taxa de ocupação?$faq$, $faq$É a relação entre a área ocupada pela projeção da edificação no terreno e a área do lote, conforme os critérios definidos pela legislação aplicável. Ela ajuda a determinar quanto da área do terreno pode ser ocupado pela edificação em sua projeção.$faq$, 210),
  ($faq$O que é coeficiente de aproveitamento?$faq$, $faq$É o índice utilizado para relacionar a área construída computável com a área do terreno, conforme os critérios estabelecidos pela legislação urbanística. Ele ajuda a definir o potencial construtivo do imóvel.$faq$, 220),
  ($faq$O que é área construída?$faq$, $faq$É a área resultante das partes da edificação consideradas conforme os critérios aplicáveis à legislação e ao processo. É importante diferenciar área construída, área computável, área ocupada e outras classificações, pois cada uma pode possuir finalidade diferente no projeto e na aprovação.$faq$, 230),
  ($faq$O que é área permeável?$faq$, $faq$É a parcela do terreno que permite a infiltração da água no solo, de acordo com os critérios estabelecidos pela legislação aplicável. Sua dimensão pode ser um dos parâmetros que precisam ser atendidos na implantação da edificação.$faq$, 240),
  ($faq$O que é gabarito de altura?$faq$, $faq$É o limite ou parâmetro relacionado à altura máxima ou ao número de pavimentos permitido para determinada edificação, conforme a legislação aplicável. O critério utilizado pode variar conforme o município, zoneamento e características do imóvel.$faq$, 250),
  ($faq$Como sabemos onde a edificação pode ser implantada no terreno?$faq$, $faq$A implantação é definida a partir da análise conjunta de:

- limites e dimensões do terreno;
- levantamento planialtimétrico;
- matrícula e documentação;
- legislação urbanística;
- recuos;
- taxa de ocupação;
- coeficiente de aproveitamento;
- área permeável;
- gabarito;
- acessos;
- topografia;
- restrições específicas do imóvel.

A posição final precisa atender às condições técnicas e legais aplicáveis.$faq$, 260),
  ($faq$Posso construir até o limite do terreno?$faq$, $faq$Não necessariamente.

A possibilidade de construir junto aos limites depende da legislação aplicável e das condições específicas do imóvel. Devem ser analisados os recuos, características da edificação, zoneamento e demais exigências.$faq$, 270),
  ($faq$Por que não posso colocar a casa onde eu quiser no lote?$faq$, $faq$Porque a implantação precisa respeitar condições técnicas e legais. Além da legislação, a posição da edificação deve considerar topografia, acessos, drenagem, fundações, orientação, áreas permeáveis, recuos e possíveis interferências com edificações existentes ou vizinhas.$faq$, 280),
  ($faq$Por que a posição da edificação precisa considerar os níveis do terreno?$faq$, $faq$Porque o desnível interfere diretamente na implantação e na execução. A topografia pode influenciar:

- acessos;
- escadas e rampas;
- cortes e aterros;
- fundações;
- contenções;
- drenagem;
- níveis internos e externos.

Ignorar os níveis pode resultar em soluções inadequadas ou incompatíveis com o terreno real.$faq$, 290),
  ($faq$Por que a topografia é tão importante para a arquitetura?$faq$, $faq$Porque a arquitetura precisa ser desenvolvida sobre a condição real do terreno. A topografia interfere na implantação, nos níveis, nos acessos, nos cortes e aterros, na drenagem, nas fundações e em outras decisões de projeto.

O projeto não deve ser pensado como se o terreno fosse plano quando ele não é.$faq$, 300),
  ($faq$O projeto precisa considerar os imóveis vizinhos?$faq$, $faq$Sim. As construções vizinhas podem interferir na implantação, nos acessos, nos limites, na drenagem, nos afastamentos e em outras condições do projeto.

Além disso, os confrontantes e suas divisas precisam estar corretamente representados na base utilizada para o desenvolvimento.$faq$, 310),
  ($faq$Por que a drenagem precisa ser considerada desde a arquitetura?$faq$, $faq$Porque a água influencia diretamente a implantação e o funcionamento da edificação e do terreno.

A drenagem precisa ser pensada em conjunto com níveis, áreas impermeáveis, acessos, cobertura, terreno e demais elementos para evitar que a solução seja definida apenas depois que o projeto já estiver consolidado.$faq$, 320),
  ($faq$O que acontece quando o terreno possui grande declividade?$faq$, $faq$A declividade pode exigir soluções específicas de implantação e engenharia.

Podem ser necessários:

- cortes;
- aterros;
- contenções;
- drenagem;
- adaptações de acesso;
- soluções específicas de fundação.

A necessidade dessas soluções deve ser definida a partir das características reais do terreno e dos estudos técnicos pertinentes.$faq$, 330),
  ($faq$Quando são necessários cortes e aterros?$faq$, $faq$Quando a implantação projetada exige alteração dos níveis naturais do terreno.

A necessidade e a dimensão dessas intervenções devem ser avaliadas considerando topografia, projeto, acessos, drenagem, estabilidade e demais condições técnicas.$faq$, 340),
  ($faq$Quando pode ser necessária uma contenção?$faq$, $faq$A contenção pode ser necessária quando existe uma diferença de nível ou condição de terreno que exige estabilização do solo ou retenção de material. A solução adequada depende das características geotécnicas, da geometria do terreno, das cargas envolvidas e do projeto.$faq$, 350),
  ($faq$O que é uma edificação existente e como ela interfere no novo projeto?$faq$, $faq$É uma construção que já existe no imóvel. Ela precisa ser considerada no desenvolvimento porque pode interferir na área construída, implantação, afastamentos, estrutura, acessos, demolições, ampliações e situação de regularização.$faq$, 360),
  ($faq$Como sabemos se uma construção existente está regularizada?$faq$, $faq$É necessário confrontar a situação física da edificação com os registros e documentos disponíveis e, quando necessário, consultar o cadastro ou o órgão municipal competente.

A análise pode envolver área construída, projetos aprovados, averbações e demais registros aplicáveis.$faq$, 370),
  ($faq$O que acontece se a construção existente não estiver regularizada?$faq$, $faq$A situação precisa ser analisada antes de definir a nova intervenção. Dependendo do caso, pode ser necessário realizar um procedimento de regularização, adequar o projeto ou atender a outras exigências do município.$faq$, 380),
  ($faq$O que é um projeto de regularização?$faq$, $faq$É o projeto desenvolvido para representar e formalizar a situação de uma edificação existente perante o órgão competente, buscando sua regularização conforme o procedimento aplicável.

Pode envolver levantamento da situação existente, documentação, análise dos parâmetros urbanísticos e demais elementos exigidos.$faq$, 390),
  ($faq$O que é um projeto de reforma?$faq$, $faq$É o projeto desenvolvido para representar e orientar alterações realizadas em uma edificação existente, como modificações de ambientes, elementos construtivos ou características da construção. A necessidade de aprovação e os documentos envolvidos dependem do tipo e da extensão da intervenção.$faq$, 400),
  ($faq$O que é uma ampliação?$faq$, $faq$É a intervenção que aumenta a área ou o volume de uma edificação existente.

A ampliação deve ser analisada em conjunto com a situação existente, os parâmetros urbanísticos, a estrutura, as instalações e os demais requisitos aplicáveis.$faq$, 410),
  ($faq$Posso reformar, ampliar ou construir sobre uma edificação existente?$faq$, $faq$Depende das condições do imóvel, da edificação existente, da legislação e do tipo de intervenção pretendida. É necessário verificar a situação documental e cadastral da construção, suas características e os parâmetros aplicáveis à nova intervenção.$faq$, 420),
  ($faq$Posso demolir uma parte da construção existente?$faq$, $faq$A possibilidade depende das características da edificação, da intervenção pretendida e dos procedimentos aplicáveis. Quando houver demolição, também devem ser avaliadas as necessidades documentais, técnicas e de aprovação correspondentes.$faq$, 430),
  ($faq$O que acontece quando o projeto possui uma edificação existente e uma nova construção?$faq$, $faq$As duas situações precisam ser analisadas conjuntamente.

É necessário verificar a situação da edificação existente, sua regularidade, a área construída, os afastamentos, a implantação da nova construção e possíveis interferências entre as duas.$faq$, 440),
  ($faq$Posso alterar a posição ou o tamanho dos ambientes depois que o projeto começou?$faq$, $faq$Em muitos casos, sim, desde que a alteração seja analisada antes de ser incorporada.

Uma mudança aparentemente simples pode afetar estrutura, instalações, área construída, implantação, aprovação e compatibilização. Por isso, alterações devem ser consultadas antes da continuidade do desenvolvimento.$faq$, 450),
  ($faq$Uma alteração na arquitetura pode afetar a estrutura ou as instalações?$faq$, $faq$Sim. Uma alteração arquitetônica pode gerar impactos em outras disciplinas.

Por exemplo:

*Arquitetura → Estrutura → Instalações → Compatibilização → Aprovação*

Por isso, nenhuma alteração deve ser considerada isoladamente quando o projeto já estiver avançado.$faq$, 460),
  ($faq$Por que a arquitetura precisa ser compatibilizada com a engenharia?$faq$, $faq$Porque arquitetura e engenharia possuem informações que precisam funcionar conjuntamente. Uma posição de parede, abertura, nível, equipamento ou ambiente pode interferir na estrutura, nas instalações, nas fundações ou em outras soluções técnicas.

A compatibilização permite identificar essas interferências antes da execução.$faq$, 470),
  ($faq$Por que uma mudança aparentemente pequena pode gerar várias alterações?$faq$, $faq$Porque os projetos são interdependentes.

Uma alteração em um ambiente, por exemplo, pode modificar paredes, portas, estrutura, instalações, áreas, quantitativos, documentação e até parâmetros de aprovação. Por isso, o impacto de uma alteração deve ser analisado antes de sua incorporação.$faq$, 480),
  ($faq$Posso aumentar a área construída depois que o projeto começou?$faq$, $faq$É possível avaliar a alteração, mas primeiro é necessário verificar se o aumento permanece dentro dos parâmetros permitidos.

Devem ser analisados, entre outros:

- recuos;
- taxa de ocupação;
- coeficiente de aproveitamento;
- área permeável;
- implantação;
- estrutura;
- instalações;
- situação do processo de aprovação.$faq$, 490),
  ($faq$O que acontece se a área construída ultrapassar o permitido?$faq$, $faq$O projeto pode deixar de atender aos parâmetros urbanísticos aplicáveis. Dependendo da situação, será necessário adequar a proposta, verificar a possibilidade de regularização ou adotar o procedimento indicado pelo órgão competente.$faq$, 500),
  ($faq$O projeto aprovado é igual ao projeto executivo?$faq$, $faq$Não necessariamente.

O projeto destinado à aprovação atende aos requisitos necessários para análise pelo órgão competente, enquanto o projeto executivo contém informações técnicas necessárias para orientar a execução, conforme seu escopo.

Um projeto aprovado não deve ser automaticamente considerado equivalente ao conjunto completo de informações executivas da obra.$faq$, 510),
  ($faq$Posso começar a construir enquanto o projeto está em aprovação?$faq$, $faq$Isso depende das autorizações e condições aplicáveis ao empreendimento e ao município. O simples protocolo do projeto não significa autorização para iniciar a obra. Antes de iniciar qualquer atividade construtiva, devem ser verificadas as autorizações necessárias.$faq$, 520),
  ($faq$A aprovação do projeto significa que posso iniciar a obra?$faq$, $faq$Normalmente, não.

A aprovação do projeto e a autorização para iniciar a construção podem corresponder a etapas diferentes, conforme o procedimento municipal. É necessário verificar se o alvará ou outra autorização necessária já foi emitida.$faq$, 530),
  ($faq$O projeto precisa seguir exatamente o que foi aprovado?$faq$, $faq$A execução deve respeitar o projeto e as condições aprovadas, observando também os demais projetos e documentos aplicáveis. Alterações posteriores devem ser analisadas antes de serem executadas.$faq$, 540),
  ($faq$O que acontece se eu construir diferente do projeto aprovado?$faq$, $faq$A construção pode ficar em desacordo com o projeto e com as condições aprovadas. Dependendo da alteração, podem ser necessárias correções, regularização, alteração do projeto ou outras providências perante o órgão competente.$faq$, 550),
  ($faq$O que acontece se o projeto aprovado precisar ser alterado durante a obra?$faq$, $faq$A alteração deve ser analisada antes de ser executada. Dependendo do caso, pode ser necessário atualizar projetos, obter nova aprovação, realizar procedimento específico ou adequar a obra ao projeto aprovado.$faq$, 560)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 30 and archived_at is null), q, a, o from (values
  ($faq$A matrícula e o levantamento planialtimétrico precisam ser compatíveis?$faq$, $faq$Sim. As informações devem ser conferidas antes do desenvolvimento e, quando aplicável, do protocolo do projeto.

A matrícula representa a referência documental do imóvel, enquanto o levantamento planialtimétrico representa as condições físicas encontradas no terreno.

*Antes de projetar, precisamos verificar se estamos trabalhando sobre o imóvel correto e com informações confiáveis.*$faq$, 570),
  ($faq$E se a área da matrícula for diferente da área levantada?$faq$, $faq$A divergência deve ser analisada para identificar sua origem. Ela pode estar relacionada ao levantamento, à documentação ou a alterações ocorridas no imóvel ao longo do tempo.

Dependendo do caso, pode ser necessário corrigir o levantamento, apresentar documentação complementar, atualizar informações, consultar o órgão responsável ou realizar algum procedimento de regularização.

*A diferença entre as áreas não significa automaticamente que será necessária uma retificação de matrícula.*$faq$, 580),
  ($faq$O que acontece quando encontramos uma divergência entre documento e terreno?$faq$, $faq$A divergência deve ser identificada, registrada e analisada antes de prosseguir. Não devemos simplesmente escolher uma das informações ou alterar o projeto para "fazer caber".

É necessário entender:

- qual informação está divergente;
- entre quais documentos existe a diferença;
- se a origem está no levantamento ou na documentação;
- se a divergência interfere no projeto;
- qual procedimento deve ser adotado.

Dependendo do caso, pode ser necessário:

- corrigir o levantamento;
- solicitar documentação complementar;
- atualizar alguma informação;
- realizar uma retificação;
- consultar o órgão responsável;
- adequar o projeto.

*A divergência deve ser resolvida na origem sempre que possível, e não escondida dentro do projeto.*$faq$, 590),
  ($faq$O que é uma retificação de matrícula?$faq$, $faq$É o procedimento utilizado para corrigir ou atualizar informações da matrícula quando existe alguma divergência ou erro nos dados registrados, como área, medidas, confrontações ou descrição do imóvel.$faq$, 600),
  ($faq$Quem solicita uma retificação de matrícula?$faq$, $faq$Em regra, a solicitação é feita pelo proprietário ou por seu representante legal, diretamente ao Cartório de Registro de Imóveis competente, conforme o tipo de retificação. Dependendo do caso, podem ser necessários documentos técnicos e outros procedimentos específicos.$faq$, 610),
  ($faq$Quem faz a retificação?$faq$, $faq$A retificação é realizada pelo Cartório de Registro de Imóveis, após apresentação e análise da documentação necessária.

Dependendo da situação, pode ser necessária documentação técnica elaborada por profissional habilitado, como levantamento topográfico, planta, memorial descritivo e respectiva ART/RRT.$faq$, 620),
  ($faq$Posso iniciar o projeto sem a matrícula?$faq$, $faq$Depende do projeto e do processo.

A matrícula é importante porque confirma os dados documentais que servirão de referência para o desenvolvimento, permitindo conferir área, medidas, confrontantes e localização. Antes de iniciar, devemos verificar se já temos as informações necessárias para desenvolver o projeto sobre uma base documental adequada.$faq$, 630),
  ($faq$Posso utilizar uma matrícula antiga?$faq$, $faq$Depende do processo e da situação atual do imóvel.

Uma matrícula antiga pode conter informações que continuam válidas, mas também pode não refletir alterações posteriores, como mudanças de proprietário, averbações, construções, alterações de área, desmembramentos ou unificações. Por isso, é necessário verificar se o documento está atualizado e se atende às exigências do processo.$faq$, 640),
  ($faq$Quem deve providenciar a demarcação do terreno?$faq$, $faq$Quando a situação física dos limites do imóvel não estiver clara, pode ser necessária uma demarcação ou outro procedimento técnico adequado.

A responsabilidade pela contratação deve ser definida conforme a necessidade do serviço e o escopo contratado.$faq$, 650),
  ($faq$O que acontece se os limites do terreno não estiverem claros?$faq$, $faq$A situação deve ser esclarecida antes da definição definitiva da implantação. Pode ser necessário realizar levantamento, demarcação ou obter documentação complementar para identificar corretamente os limites do imóvel.$faq$, 660),
  ($faq$O que acontece se houver divergência entre matrícula, cadastro municipal e levantamento?$faq$, $faq$A divergência deve ser analisada entre as diferentes fontes. É necessário identificar qual informação está divergente, compreender sua origem e verificar qual procedimento deve ser adotado.

Dependendo do caso, podem ser necessárias correções cadastrais, documentação complementar, atualização do levantamento ou procedimento registral.$faq$, 670)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 40 and archived_at is null), q, a, o from (values
  ($faq$O que é um levantamento planialtimétrico?$faq$, $faq$É o levantamento técnico que representa as características físicas e topográficas do terreno.

Ele pode apresentar informações como:

- dimensões e limites;
- área levantada;
- níveis e desníveis;
- cotas altimétricas;
- curvas de nível;
- posicionamento do terreno;
- confrontantes;
- construções e elementos existentes;
- muros;
- árvores;
- postes;
- cursos d'água;
- demais elementos relevantes.

*A matrícula mostra o imóvel do ponto de vista documental; o planialtimétrico mostra como esse imóvel se apresenta fisicamente no terreno.*$faq$, 680),
  ($faq$O que deve constar em um levantamento planialtimétrico?$faq$, $faq$O conteúdo necessário depende do projeto e da finalidade do levantamento, mas, de forma geral, devem ser representadas as informações necessárias para compreender corretamente o terreno.

Entre elas podem estar:

- norte;
- limites e dimensões do lote;
- área;
- cotas e níveis;
- curvas de nível;
- localização do imóvel;
- quadra e referência de esquina;
- confrontantes e respectivas divisas;
- elementos existentes;
- curvas de nível que ultrapassem o limite do lote quando necessárias à compreensão da topografia;
- identificação e informações técnicas do levantamento.

Quando utilizado para desenvolvimento e aprovação, o levantamento deve ser compatível com a finalidade para a qual foi contratado e com as informações exigidas pelo processo.$faq$, 690),
  ($faq$Por que o norte precisa estar indicado?$faq$, $faq$A indicação do norte permite compreender a orientação do terreno e sua relação com o entorno. Essa informação é importante para o desenvolvimento do projeto, análise de implantação, orientação dos ambientes e compatibilização com outras informações técnicas.$faq$, 700),
  ($faq$Por que precisamos das curvas de nível?$faq$, $faq$As curvas de nível permitem representar graficamente as variações de altitude do terreno.

Elas ajudam a compreender:

- declividades;
- desníveis;
- pontos altos e baixos;
- comportamento do terreno;
- necessidade de cortes e aterros;
- implantação da edificação;
- soluções de drenagem e fundação, quando aplicável.$faq$, 710),
  ($faq$Por que precisamos identificar os confrontantes e suas divisas?$faq$, $faq$Porque os confrontantes ajudam a confirmar a posição e os limites do imóvel em relação aos terrenos vizinhos. A identificação das divisas e respectivas medidas permite comparar as informações do levantamento com a documentação do imóvel e reduzir o risco de implantação incorreta.$faq$, 720),
  ($faq$Por que precisamos representar elementos existentes no terreno?$faq$, $faq$Muros, edificações, árvores, postes, cursos d'água, acessos e outros elementos podem interferir diretamente no desenvolvimento do projeto. Conhecer essas condições permite que a implantação seja feita considerando a realidade encontrada no local.$faq$, 730),
  ($faq$Por que precisamos conferir o planialtimétrico antes de projetar?$faq$, $faq$Porque o planialtimétrico representa as condições reais encontradas no terreno e será utilizado como base para o desenvolvimento do projeto.

A conferência permite verificar:

- área;
- dimensões;
- formato;
- confrontantes;
- localização;
- níveis;
- limites físicos;
- elementos existentes;
- compatibilidade com a matrícula.

Um erro na base pode ser reproduzido em todas as etapas seguintes.$faq$, 740),
  ($faq$Quem pode realizar o levantamento?$faq$, $faq$O levantamento deve ser realizado por profissional habilitado para o serviço, observando suas atribuições profissionais e os requisitos técnicos aplicáveis. Quando exigido, o serviço deve possuir a respectiva responsabilidade técnica formalizada.$faq$, 750)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 50 and archived_at is null), q, a, o from (values
  ($faq$O que é compatibilização de projetos?$faq$, $faq$É a conferência conjunta das diferentes disciplinas e informações envolvidas no empreendimento para identificar conflitos, divergências ou interferências antes da execução.

Pode envolver, por exemplo:

- arquitetura × estrutura;
- estrutura × instalações;
- arquitetura × instalações;
- projeto × terreno;
- parâmetros legais e normativas;
- posição de equipamentos e elementos construtivos.

A compatibilização busca identificar problemas no papel antes que eles se transformem em problemas na obra.$faq$, 760),
  ($faq$Por que preciso de projetos complementares?$faq$, $faq$Além do projeto arquitetônico e dos projetos de engenharia que fazem parte do desenvolvimento da edificação, algumas situações podem exigir projetos ou estudos complementares específicos, de acordo com as características do imóvel, da obra e das exigências dos órgãos responsáveis.

Entre os casos que podem demandar estudos ou projetos adicionais estão:

- projeto de prevenção e combate a incêndio;
- projeto de drenagem pluvial;
- projeto de contenção ou muro de arrimo;
- projeto de terraplenagem;
- projeto de pavimentação ou acessos;
- projeto de adequação de acessibilidade;
- estudos ou projetos relacionados à vegetação e supressão arbórea;
- estudos ambientais;
- projetos relacionados à infraestrutura existente no terreno;
- outros projetos ou estudos específicos exigidos para o empreendimento.

A necessidade desses complementos é avaliada conforme as características do projeto, do terreno e das exigências técnicas e legais aplicáveis ao imóvel.$faq$, 770),
  ($faq$Qual a diferença entre projeto arquitetônico e projeto estrutural?$faq$, $faq$O projeto arquitetônico define principalmente a organização e configuração da edificação, como ambientes, implantação, dimensões e características arquitetônicas.

O projeto estrutural trata do dimensionamento e detalhamento da estrutura, considerando as cargas e condições previstas para a edificação.

São disciplinas diferentes, mas devem trabalhar de forma compatibilizada.$faq$, 780),
  ($faq$O que é um projeto pronto para aprovação?$faq$, $faq$É o projeto que passou pelas etapas necessárias de desenvolvimento e conferência para ser apresentado ao órgão responsável, considerando a documentação, informações do imóvel e requisitos aplicáveis ao processo.

Antes do protocolo, devem ser verificadas as informações cadastrais, documentação, projetos, responsabilidades técnicas e demais requisitos necessários.$faq$, 790)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 60 and archived_at is null), q, a, o from (values
  ($faq$O que é uma sondagem?$faq$, $faq$A sondagem é um estudo de investigação do subsolo, realizado para conhecer suas características em profundidade.

Ela pode fornecer informações como:

- perfil das camadas do subsolo;
- resistência do solo;
- profundidade das camadas;
- presença de água, quando identificada;
- condições que podem influenciar a escolha e o dimensionamento das fundações.

Enquanto o planialtimétrico representa principalmente as condições da superfície, a sondagem investiga as condições abaixo dela.$faq$, 800),
  ($faq$O que é sondagem SPT?$faq$, $faq$A sondagem SPT (*Standard Penetration Test*) é um método de investigação geotécnica utilizado para obter informações sobre as camadas do subsolo e sua resistência à penetração.

Os resultados auxiliam na avaliação das condições do terreno e no desenvolvimento das soluções de fundação, conforme as características do empreendimento e as normas aplicáveis.$faq$, 810),
  ($faq$Por que preciso realizar uma sondagem?$faq$, $faq$A sondagem fornece informações fundamentais para o desenvolvimento das soluções de fundação.

O solo pode apresentar características diferentes em profundidade e em diferentes pontos do terreno. Por isso, a investigação permite que o profissional responsável desenvolva a solução considerando as condições efetivamente encontradas.

A sondagem não deve ser tratada apenas como um documento para aprovação. Ela fornece dados utilizados no desenvolvimento da engenharia da edificação.$faq$, 820),
  ($faq$Quem deve contratar a sondagem?$faq$, $faq$A contratação deve ser definida conforme o escopo do serviço e a organização do empreendimento.

Quando a sondagem não estiver incluída na contratação da equipe, o cliente deverá providenciar o serviço com empresa ou profissional habilitado, conforme orientação técnica.$faq$, 830),
  ($faq$A sondagem é necessária para qualquer tipo de obra?$faq$, $faq$A necessidade e o tipo de investigação dependem das características da obra, do terreno, da fundação prevista e das exigências técnicas aplicáveis. A definição deve ser feita pelo profissional responsável, considerando as condições específicas do empreendimento.$faq$, 840),
  ($faq$Posso escolher o tipo de fundação antes da sondagem?$faq$, $faq$A escolha da fundação deve considerar as características do subsolo.

Por isso, não é adequado definir definitivamente a solução de fundação sem as informações necessárias sobre o terreno, quando a investigação geotécnica for requerida.$faq$, 850),
  ($faq$O resultado da sondagem pode alterar o projeto de fundações?$faq$, $faq$Sim. As condições encontradas no subsolo podem indicar uma solução diferente daquela inicialmente considerada. Por isso, a fundação deve ser dimensionada com base nas informações técnicas disponíveis e nas condições efetivamente identificadas.$faq$, 860),
  ($faq$O que acontece se o solo encontrado for diferente do esperado?$faq$, $faq$A situação deve ser avaliada pelo profissional responsável.

Dependendo das características encontradas, pode ser necessário alterar o tipo, profundidade, dimensões ou outras características da fundação, além de revisar soluções relacionadas ao projeto.$faq$, 870),
  ($faq$A sondagem é necessária para o projeto estrutural?$faq$, $faq$Para o dimensionamento adequado das fundações, é necessário conhecer as condições do solo por meio de investigação geotécnica apropriada.

A sondagem fornece dados fundamentais para essa avaliação, e o tipo e a quantidade de investigação devem ser definidos conforme as características do empreendimento, do terreno e as normas técnicas aplicáveis.$faq$, 880),
  ($faq$O que é projeto de fundação?$faq$, $faq$É o projeto que define e dimensiona os elementos responsáveis por transmitir as cargas da edificação ao solo. A solução depende das características da estrutura, das cargas, das condições do terreno e dos resultados da investigação geotécnica.$faq$, 890),
  ($faq$Qual a diferença entre fundação e estrutura?$faq$, $faq$A estrutura é o conjunto de elementos que recebe e transmite as cargas da edificação. A fundação é o conjunto de elementos responsável por transmitir essas cargas ao solo. As duas partes trabalham conjuntamente e precisam ser dimensionadas e compatibilizadas.$faq$, 900),
  ($faq$O projeto estrutural é realmente necessário?$faq$, $faq$A necessidade e o escopo do projeto estrutural dependem das características da edificação e das exigências técnicas e legais aplicáveis. Quando necessário, ele fornece o dimensionamento dos elementos estruturais e as informações necessárias para a execução adequada da estrutura.

Não deve ser entendido apenas como uma exigência burocrática: trata-se de uma etapa técnica do desenvolvimento da edificação.$faq$, 910),
  ($faq$Por que a estrutura precisa ser compatibilizada com a arquitetura?$faq$, $faq$Porque os elementos estruturais precisam ocupar posições compatíveis com os ambientes, paredes, aberturas, níveis e demais elementos arquitetônicos. A compatibilização permite identificar conflitos antes da execução e reduzir alterações durante a obra.$faq$, 920)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 70 and archived_at is null), q, a, o from (values
  ($faq$O que é RT?$faq$, $faq$RT significa Responsável Técnico. É o profissional legalmente habilitado que assume a responsabilidade pela realização de determinado serviço técnico, dentro de suas atribuições profissionais.

O RT pode ser responsável, por exemplo, por:

- projeto;
- execução;
- projeto estrutural;
- instalações;
- avaliações;
- outros serviços técnicos.

RT é o profissional responsável. ART e RRT são os registros que formalizam essa responsabilidade, conforme o conselho profissional aplicável.$faq$, 930),
  ($faq$Qual a diferença entre o profissional que projeta e o profissional que executa a obra?$faq$, $faq$O profissional responsável pelo projeto responde tecnicamente pelas atividades de projeto que assumiu.

O profissional responsável pela execução responde tecnicamente pelas atividades de execução que assumiu.

São responsabilidades distintas e podem ser exercidas por profissionais diferentes, desde que habilitados e com atribuições compatíveis.$faq$, 940),
  ($faq$O que é ART?$faq$, $faq$ART significa Anotação de Responsabilidade Técnica. É o documento utilizado para registrar a responsabilidade técnica de profissionais vinculados ao sistema CONFEA/CREA.

A ART identifica, entre outras informações:

- profissional responsável;
- contratante;
- serviço;
- atividades técnicas;
- local de realização.

A ART deve corresponder ao serviço efetivamente realizado e às atribuições do profissional.$faq$, 950),
  ($faq$O que é RRT?$faq$, $faq$RRT significa Registro de Responsabilidade Técnica. É utilizado para registrar a responsabilidade técnica dos profissionais vinculados ao CAU: Conselho de Arquitetura e Urbanismo.

De forma simplificada:

- CREA → ART
- CAU → RRT$faq$, 960),
  ($faq$Quando precisamos de ART ou RRT?$faq$, $faq$A necessidade depende do serviço realizado, do profissional responsável, de suas atribuições e das exigências aplicáveis ao processo.

É necessário verificar:

- qual serviço será realizado;
- quem será o responsável;
- qual conselho profissional se aplica;
- se o profissional possui atribuição compatível;
- qual documento é exigido pelo órgão.

A ART/RRT deve representar exatamente a responsabilidade técnica que está sendo assumida.$faq$, 970),
  ($faq$Preciso de ART/RRT para todos os serviços?$faq$, $faq$A necessidade depende do serviço, das atribuições profissionais, da legislação aplicável e das exigências do órgão ou conselho competente. Por isso, cada atividade deve ser analisada individualmente.$faq$, 980),
  ($faq$Uma ART/RRT de projeto substitui a de execução?$faq$, $faq$Não necessariamente.

Projeto e execução são atividades distintas e podem exigir responsabilidades técnicas próprias. É necessário verificar quais atividades serão realizadas e quais registros são necessários para cada uma delas.$faq$, 990),
  ($faq$Posso ter um profissional para o projeto e outro para a execução?$faq$, $faq$Sim. Projeto e execução são atividades diferentes e podem possuir responsáveis técnicos diferentes.

Um profissional pode ser responsável pelo projeto e outro pela execução, desde que cada um possua habilitação e atribuição compatíveis com sua atividade e formalize a respectiva responsabilidade técnica.$faq$, 1000),
  ($faq$Preciso contratar um responsável pela execução antes da aprovação?$faq$, $faq$Não necessariamente.

A necessidade depende do tipo de processo, da legislação aplicável e da etapa em que essa informação é exigida. Quando a definição do executor for necessária, a equipe orientará o cliente sobre o momento adequado e os documentos necessários.$faq$, 1010),
  ($faq$O responsável técnico pelo projeto precisa ser o mesmo da obra?$faq$, $faq$Não necessariamente.

As responsabilidades podem ser atribuídas a profissionais diferentes, desde que cada profissional esteja habilitado para a atividade que irá desempenhar e que as responsabilidades técnicas estejam devidamente formalizadas.$faq$, 1020),
  ($faq$O que acontece se o responsável técnico mudar durante o processo?$faq$, $faq$A alteração deve ser comunicada e formalizada conforme o procedimento aplicável.

Pode ser necessário atualizar documentos, registros de responsabilidade técnica, procurações, cadastros ou informações do processo.$faq$, 1030),
  ($faq$Quem é responsável por corrigir uma exigência técnica?$faq$, $faq$Depende do conteúdo da exigência.

A responsabilidade deve ser direcionada ao profissional ou equipe que possui competência sobre o item solicitado, considerando também o escopo contratado. A equipe de aprovação pode coordenar a resposta, mas a correção técnica deve ser realizada pelo profissional habilitado responsável pela respectiva disciplina, quando aplicável.$faq$, 1040)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 80 and archived_at is null), q, a, o from (values
  ($faq$Qual a diferença entre aprovação, licenciamento e alvará?$faq$, $faq$Aprovação é a manifestação favorável do órgão competente quanto ao projeto ou solicitação apresentada.

Licenciamento corresponde ao procedimento de autorização ou regularização de determinada atividade, conforme o órgão e a legislação aplicável.

Alvará é o documento emitido pelo órgão competente que formaliza determinada autorização, conforme o procedimento específico.

Os conceitos e etapas podem variar conforme o município e o tipo de empreendimento.$faq$, 1050),
  ($faq$O que é um protocolo?$faq$, $faq$É o registro formal de uma solicitação junto ao órgão responsável. É quando o processo é oficialmente apresentado para análise e recebe uma identificação, como número e data de protocolo.

Protocolar não significa aprovar. Significa apresentar oficialmente o processo para análise.$faq$, 1060),
  ($faq$O que acontece depois que meu projeto é protocolado?$faq$, $faq$O órgão responsável inicia a análise do processo.

Durante essa etapa, pode:

- aprovar;
- solicitar correções;
- emitir exigência;
- solicitar documentos adicionais;
- solicitar esclarecimentos;
- ou tomar outra decisão prevista para aquele procedimento.

A equipe acompanha o processo e atua nas etapas que fazem parte do escopo contratado.$faq$, 1070),
  ($faq$O que significa um processo estar "em análise"?$faq$, $faq$Significa que o processo foi apresentado ao órgão e está sendo avaliado conforme os critérios e procedimentos aplicáveis.

Estar em análise não significa aprovação ou reprovação.$faq$, 1080),
  ($faq$O que significa "aguardando documentação" ou "aguardando pagamento"?$faq$, $faq$Significa que existe uma pendência que precisa ser atendida antes da continuidade de determinada etapa do processo.

A pendência deve ser identificada para que seja possível definir quem deve providenciar o documento ou pagamento e qual o impacto sobre o andamento.$faq$, 1090),
  ($faq$O que é uma exigência?$faq$, $faq$É uma solicitação do órgão para que o processo seja corrigido, complementado ou esclarecido.

Pode estar relacionada a:

- documentos;
- informações;
- projeto;
- legislação;
- dados cadastrais;
- requisitos específicos do processo.

Exigência não significa necessariamente reprovação. É uma etapa de análise que precisa ser atendida para que o processo continue.$faq$, 1100),
  ($faq$Quem responde uma exigência?$faq$, $faq$Depende do conteúdo da exigência. A equipe deve primeiro analisar o que foi solicitado e identificar quem possui a informação ou competência necessária para solucioná-la.

Pode ser necessária a participação:

- da equipe de aprovação;
- do arquiteto;
- do engenheiro;
- do responsável técnico;
- do cliente;
- de outro profissional;
- ou de mais de uma dessas partes.$faq$, 1110),
  ($faq$Quem acompanha o processo depois do protocolo?$faq$, $faq$A equipe responsável pelo serviço contratado acompanha a tramitação conforme o escopo estabelecido. Quando houver dependência do cliente ou de outro profissional, a continuidade também poderá depender dessas partes.$faq$, 1120),
  ($faq$Como o cliente fica sabendo quando houver uma exigência?$faq$, $faq$A equipe responsável deve comunicar ao cliente quando a exigência gerar alguma providência ou informação que dependa dele, observando o fluxo de comunicação definido para o processo.$faq$, 1130),
  ($faq$O que acontece depois que uma exigência é respondida?$faq$, $faq$O processo retorna para análise do órgão.

A partir daí, poderá ocorrer uma nova análise, aprovação, nova exigência, solicitação de esclarecimentos ou outro procedimento previsto. Responder uma exigência não significa que ela foi automaticamente aceita. É necessário aguardar a nova análise do órgão.$faq$, 1140),
  ($faq$O que significa um processo indeferido?$faq$, $faq$Significa que o órgão responsável decidiu pela não aprovação da solicitação apresentada naquele processo.

Nesse caso, é necessário verificar a fundamentação da decisão e avaliar, conforme o procedimento aplicável:

- possibilidade de recurso;
- correção do projeto;
- complementação documental;
- novo protocolo;
- outras providências.$faq$, 1150),
  ($faq$A aprovação depende da equipe?$faq$, $faq$A equipe é responsável por preparar, organizar, protocolar e acompanhar o processo conforme o serviço contratado. A decisão final sobre a aprovação pertence ao órgão responsável pela análise. Além disso, algumas etapas dependem de informações e decisões do cliente ou da atuação de outros profissionais.

A equipe trabalha para apresentar o processo de forma completa e adequada, mas a decisão do órgão pertence ao próprio órgão.$faq$, 1160),
  ($faq$O que a Prefeitura analisa?$faq$, $faq$A análise depende do tipo de processo, mas pode envolver aspectos como documentação, características do imóvel, implantação, parâmetros urbanísticos, atendimento à legislação municipal e demais requisitos aplicáveis. Cada órgão possui suas próprias competências e critérios de análise.$faq$, 1170),
  ($faq$O que acontece quando o órgão público demora além do prazo estimado?$faq$, $faq$O processo deve continuar sendo acompanhado para verificar sua situação e eventual necessidade de providências. O prazo efetivo pode ser influenciado pelo fluxo interno do órgão, exigências, documentos pendentes e outras circunstâncias do processo.$faq$, 1180),
  ($faq$O que é aprovação de projeto?$faq$, $faq$É a manifestação favorável do órgão competente quanto ao projeto apresentado, após a análise dos requisitos aplicáveis ao processo. A aprovação deve ser diferenciada de outras etapas e documentos, como alvarás, licenças ou autorizações, que podem ser necessários conforme o empreendimento.$faq$, 1190),
  ($faq$O que é alvará de construção?$faq$, $faq$É o documento emitido pelo órgão competente que autoriza determinada atividade construtiva, conforme as regras e condições aplicáveis ao imóvel e ao projeto. A aprovação do projeto e a emissão do alvará podem fazer parte de etapas distintas, dependendo do procedimento adotado pelo município.$faq$, 1200),
  ($faq$O que é habite-se?$faq$, $faq$É o documento emitido pelo órgão competente que atesta, conforme o procedimento municipal aplicável, a condição da edificação para ocupação. Sua emissão normalmente ocorre em uma etapa posterior à execução da obra e está relacionada à conclusão e regularidade da edificação perante o município.$faq$, 1210),
  ($faq$Depois que o projeto foi aprovado, o processo está totalmente encerrado?$faq$, $faq$Não necessariamente.

Dependendo do empreendimento, ainda podem existir etapas posteriores, como emissão de alvará, licenças, autorizações, execução da obra, vistoria, habite-se ou regularização final.$faq$, 1220),
  ($faq$A aprovação em um órgão significa que todos os outros órgãos já aprovaram?$faq$, $faq$Não. Cada órgão possui competência e critérios próprios.

Um processo pode depender de manifestações, licenças ou aprovações de diferentes órgãos, conforme as características do imóvel e do empreendimento.$faq$, 1230)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 90 and archived_at is null), q, a, o from (values
  ($faq$Por que existem taxas no processo de aprovação?$faq$, $faq$As taxas são valores cobrados pelos órgãos responsáveis por determinados serviços, análises, protocolos, licenças, autorizações ou emissões de documentos. O valor e a finalidade dependem do município, tipo de processo, área, serviço e etapa.

A taxa está relacionada ao serviço ou procedimento do órgão. Ela não representa um pagamento pela aprovação em si.$faq$, 1240),
  ($faq$Toda aprovação possui as mesmas taxas?$faq$, $faq$Não. As cobranças podem variar conforme:

- município;
- tipo de processo;
- área;
- serviço solicitado;
- etapa;
- órgão responsável;
- características do empreendimento.

Cada processo deve ser analisado individualmente.$faq$, 1250),
  ($faq$Quando a taxa é solicitada?$faq$, $faq$Depende do procedimento adotado pelo órgão.

A cobrança pode ocorrer:

- no protocolo;
- após o protocolo;
- durante a análise;
- antes da emissão de determinado documento;
- em uma etapa específica.

Um fluxo simplificado pode ser:

*Processo → Geração da taxa → Pagamento → Compensação/baixa → Continuidade*$faq$, 1260),
  ($faq$Taxa solicitada significa que o processo foi aprovado?$faq$, $faq$Não. É importante diferenciar:

- Taxa gerada → cobrança emitida
- Taxa paga → cobrança quitada
- Processo em análise → órgão avaliando
- Processo aprovado → decisão favorável

O pagamento de uma taxa não significa que o projeto foi aprovado.$faq$, 1270),
  ($faq$Quem é responsável pelo pagamento das taxas?$faq$, $faq$A responsabilidade deve ser definida conforme o contrato, o escopo do serviço e o fluxo estabelecido para o processo.

Quando houver uma taxa de responsabilidade do cliente, a equipe deve informar claramente:

- o que está sendo cobrado;
- por que está sendo cobrado;
- valor;
- prazo;
- forma de pagamento;
- necessidade de comprovante;
- impacto do pagamento no andamento.$faq$, 1280),
  ($faq$Existem outros custos além do projeto?$faq$, $faq$Dependendo do empreendimento, podem existir custos relacionados a:

- levantamento topográfico;
- sondagem;
- ART/RRT;
- taxas municipais;
- licenças e autorizações;
- cartório;
- estudos complementares;
- projetos adicionais;
- outros serviços técnicos.

O que está ou não incluído deve ser verificado conforme o escopo contratado.$faq$, 1290)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 100 and archived_at is null), q, a, o from (values
  ($faq$Quanto tempo leva para meu projeto ficar pronto?$faq$, $faq$O prazo de desenvolvimento depende do tipo e da complexidade do serviço, das informações disponíveis, das etapas envolvidas e das condições estabelecidas na contratação.

O prazo de desenvolvimento do projeto é diferente do prazo de análise e aprovação pelo órgão público.$faq$, 1300),
  ($faq$Quanto tempo leva para a Prefeitura aprovar?$faq$, $faq$O prazo depende do órgão responsável, do tipo de processo e das características da solicitação.

O prazo total também pode ser influenciado por:

- documentação;
- exigências;
- alterações;
- complementações;
- respostas do cliente;
- atuação de outros profissionais;
- tempo de análise do órgão.$faq$, 1310),
  ($faq$Por que o processo pode demorar mais do que o previsto?$faq$, $faq$Uma previsão inicial pode sofrer alterações quando surgem situações durante a tramitação.

Entre elas:

- novas exigências;
- documentos pendentes;
- divergências;
- alterações solicitadas;
- estudos complementares;
- dependência de terceiros;
- prazo de análise do órgão.

A equipe acompanha essas situações e comunica alterações relevantes que impactem o andamento.$faq$, 1320),
  ($faq$O prazo depende somente da equipe?$faq$, $faq$Não. O processo envolve diferentes participantes:

- cliente;
- equipe de aprovação;
- arquitetura;
- engenharia;
- responsáveis técnicos;
- topógrafos;
- projetistas;
- Prefeitura;
- outros órgãos.

Existem etapas que dependem diretamente da equipe e outras que dependem de terceiros ou do tempo de análise dos órgãos.$faq$, 1330)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 110 and archived_at is null), q, a, o from (values
  ($faq$Posso alterar o projeto depois que ele estiver pronto?$faq$, $faq$Sim, desde que a alteração seja tecnicamente e processualmente possível. Entretanto, uma mudança pode afetar outras partes do projeto.

Por exemplo, uma alteração arquitetônica pode gerar mudanças na estrutura, instalações, documentação ou processo de aprovação. Por isso, toda alteração deve ser analisada antes de ser incorporada.$faq$, 1340),
  ($faq$Posso alterar o projeto depois do protocolo?$faq$, $faq$Depende da natureza da alteração e da etapa do processo.

Pode ser necessário:

- atualizar documentos;
- substituir desenhos;
- realizar nova análise;
- pagar nova taxa;
- realizar novo protocolo;
- seguir procedimento específico do órgão.$faq$, 1350),
  ($faq$Posso alterar o projeto depois da aprovação?$faq$, $faq$Uma alteração posterior à aprovação não deve ser feita simplesmente sobre o projeto aprovado.

É necessário verificar se a mudança:

- mantém as condições da aprovação;
- pode ser realizada sem novo procedimento;
- exige alteração do projeto aprovado;
- precisa passar novamente pela análise do órgão.

O projeto aprovado representa uma configuração específica do imóvel. Alterações posteriores precisam ser avaliadas.$faq$, 1360),
  ($faq$O que acontece se houver mudança de proprietário durante o processo?$faq$, $faq$A alteração deve ser comunicada à equipe, pois pode exigir atualização de documentos, cadastros, procurações ou informações do processo. O procedimento necessário dependerá da etapa em que o processo se encontra e das regras do órgão responsável.$faq$, 1370)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 120 and archived_at is null), q, a, o from (values
  ($faq$O que acontece se houver vegetação no terreno?$faq$, $faq$A existência de vegetação deve ser identificada e analisada antes da definição da implantação. Dependendo da espécie, localização, porte, legislação e intervenção pretendida, pode haver necessidade de autorização, licenciamento ou procedimento específico.$faq$, 1380),
  ($faq$Quando é necessária autorização para supressão vegetal?$faq$, $faq$A necessidade depende da existência de vegetação protegida, das características da área, do tipo de intervenção e da legislação ambiental aplicável. Antes de remover qualquer vegetação, é necessário verificar a necessidade de autorização junto ao órgão competente.$faq$, 1390),
  ($faq$O que acontece se houver uma árvore próxima ao local da construção?$faq$, $faq$A árvore deve ser considerada no desenvolvimento do projeto. Sua localização pode interferir na implantação, fundações, circulação e execução, além de poder existir restrição ambiental ou necessidade de autorização para poda ou supressão.$faq$, 1400),
  ($faq$O que acontece se houver um curso d'água no terreno ou próximo dele?$faq$, $faq$A presença de curso d'água pode gerar restrições específicas relacionadas à proteção ambiental, drenagem e implantação. É necessário identificar a situação e verificar as regras e autorizações aplicáveis antes de definir a intervenção.$faq$, 1410),
  ($faq$O que é uma APP?$faq$, $faq$APP significa Área de Preservação Permanente.

É uma área protegida ambientalmente em razão de determinadas características, como a presença de recursos hídricos ou outras situações previstas na legislação. A existência de uma APP pode limitar ou condicionar a ocupação do imóvel.$faq$, 1420),
  ($faq$Quando é necessária análise ambiental?$faq$, $faq$A necessidade depende das características do imóvel, da vegetação, dos recursos hídricos, da localização, da intervenção pretendida e da legislação aplicável. Quando houver alguma condição que possa gerar restrição ambiental, a situação deve ser analisada antes da definição da implantação.$faq$, 1430),
  ($faq$Quando é necessário projeto de drenagem?$faq$, $faq$A necessidade depende das características do terreno, da edificação, da impermeabilização, dos níveis, do sistema de escoamento e das exigências aplicáveis. Em terrenos com declividade, grande área impermeabilizada ou condições específicas, pode ser necessária uma solução ou projeto de drenagem.$faq$, 1440),
  ($faq$Quando é necessária contenção de talude?$faq$, $faq$Quando existe uma condição de terreno que exige estabilização ou retenção de solo, especialmente em situações de desnível, corte, aterro ou risco de movimentação. A necessidade e a solução devem ser definidas tecnicamente.$faq$, 1450),
  ($faq$O que acontece se o terreno estiver em área de risco ou possuir alguma restrição específica?$faq$, $faq$A condição deve ser identificada e analisada antes da definição definitiva do projeto. Dependendo da restrição, podem ser necessários estudos complementares, adequações, autorizações ou soluções técnicas específicas.$faq$, 1460),
  ($faq$Quando pode ser necessária análise de outros órgãos, como órgãos ambientais ou aeroportuários?$faq$, $faq$Quando as características do imóvel ou do empreendimento estiverem relacionadas às competências de outros órgãos. Isso pode ocorrer, por exemplo, em situações envolvendo áreas ambientais, recursos hídricos, vegetação, patrimônio, segurança aeroportuária ou outras restrições específicas.$faq$, 1470),
  ($faq$A existência de uma condição especial significa que não posso construir?$faq$, $faq$Não necessariamente. A existência de uma restrição ou condição especial significa que o imóvel precisa ser analisado conforme as regras aplicáveis.

Dependendo da situação, a construção pode ser possível com determinadas condições, adequações ou autorizações.$faq$, 1480),
  ($faq$Posso descobrir essas restrições somente durante a aprovação?$faq$, $faq$Algumas restrições podem ser identificadas previamente por meio da análise documental, urbanística, ambiental e técnica.

Por isso, quanto mais completa for a análise inicial, maior a possibilidade de identificar condicionantes antes do protocolo. Ainda assim, determinados apontamentos podem surgir durante a análise do órgão.$faq$, 1490),
  ($faq$O que acontece se o terreno estiver em condomínio?$faq$, $faq$Além das exigências dos órgãos públicos, podem existir regras internas do condomínio relacionadas à implantação, fachada, recuos, alterações, padrões construtivos ou documentação.

Por isso, o regulamento e as exigências do condomínio devem ser considerados quando aplicáveis.$faq$, 1500),
  ($faq$O condomínio pode ter regras diferentes das regras da Prefeitura?$faq$, $faq$Sim. As regras do condomínio podem estabelecer condições internas adicionais.

Isso não significa que o condomínio possa substituir as exigências legais do município. O projeto precisa observar as exigências públicas e, quando aplicável, as regras internas do condomínio.$faq$, 1510),
  ($faq$O que acontece se o imóvel fizer parte de loteamento?$faq$, $faq$Além da legislação municipal, podem existir regras específicas do loteamento, como restrições de uso, implantação, recuos ou padrões construtivos. É necessário verificar a documentação e os instrumentos que estabelecem essas condições.$faq$, 1520),
  ($faq$É possível construir em terreno de esquina? Existem regras específicas?$faq$, $faq$Sim, mas terrenos de esquina podem possuir condições específicas de implantação. Podem existir regras diferenciadas relacionadas a recuos, frentes, acessos, visibilidade e demais parâmetros urbanísticos.$faq$, 1530),
  ($faq$O que muda quando o terreno possui duas ou mais frentes?$faq$, $faq$A existência de mais de uma frente pode alterar a forma como o imóvel é analisado para fins urbanísticos. É necessário verificar como cada frente é considerada pela legislação aplicável e quais parâmetros devem ser respeitados.$faq$, 1540),
  ($faq$O que acontece se houver servidão registrada na matrícula?$faq$, $faq$A servidão deve ser identificada e analisada porque pode estabelecer uma condição ou restrição sobre o imóvel. Dependendo do tipo de servidão, ela pode interferir na implantação, circulação, infraestrutura ou uso de determinada parte do terreno.$faq$, 1550),
  ($faq$O que é faixa de servidão?$faq$, $faq$É a faixa de terreno sujeita a uma servidão, na qual existe determinado direito de passagem, acesso, infraestrutura ou outra condição registrada ou juridicamente estabelecida. As limitações e possibilidades de uso dependem da natureza da servidão.$faq$, 1560),
  ($faq$O que acontece se houver rede de água, esgoto, energia ou outra infraestrutura passando pelo terreno?$faq$, $faq$A existência da infraestrutura deve ser identificada antes da definição da implantação. Dependendo de sua localização e das regras da concessionária ou órgão responsável, podem existir faixas de proteção, servidões, afastamentos ou restrições à construção.$faq$, 1570),
  ($faq$O que acontece quando o terreno precisa ser desmembrado ou unificado?$faq$, $faq$O projeto deve considerar a situação cadastral e registral do imóvel.

Quando o terreno precisar ser desmembrado, unificado ou submetido a outro procedimento de alteração imobiliária, essa etapa deve ser analisada e, quando necessário, realizada antes ou em conjunto com o desenvolvimento do projeto.$faq$, 1580),
  ($faq$Posso construir antes de concluir um desmembramento ou unificação?$faq$, $faq$Depende da situação jurídica, cadastral e do procedimento aplicável. Antes de desenvolver ou aprovar o projeto sobre uma configuração futura do imóvel, é necessário verificar se o órgão aceita a tramitação naquela condição.$faq$, 1590),
  ($faq$O que acontece quando existem duas matrículas para uma mesma área física?$faq$, $faq$A situação precisa ser analisada documental e tecnicamente. É necessário verificar os limites, áreas, registros e correspondência entre os imóveis descritos nas matrículas e a situação física encontrada.

Dependendo do caso, pode ser necessário realizar procedimento registral ou cadastral antes de prosseguir.$faq$, 1600),
  ($faq$O que acontece quando o terreno físico não corresponde ao imóvel descrito na matrícula?$faq$, $faq$A divergência deve ser identificada e analisada antes da implantação definitiva. Pode ser necessário revisar o levantamento, consultar documentos, realizar procedimento de regularização ou verificar a necessidade de alteração cadastral ou registral.$faq$, 1610)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 130 and archived_at is null), q, a, o from (values
  ($faq$Posso emitir documentos de forma online?$faq$, $faq$Muitos documentos podem atualmente ser solicitados ou emitidos digitalmente, mas isso depende do órgão responsável e do tipo de documento.

É necessário verificar:

- canal oficial;
- autenticidade;
- validade;
- eventual taxa;
- requisitos de emissão;
- aceitação pelo órgão responsável pelo processo.

Um documento digital pode possuir validade oficial, desde que emitido pelo canal competente e aceito para aquela finalidade.$faq$, 1620),
  ($faq$Posso enviar uma foto do documento pelo celular?$faq$, $faq$Depende da finalidade.

Para análise, a equipe precisa receber um documento completo, legível e com todas as informações necessárias.

Quando o processo exigir um arquivo oficial ou documento específico, uma fotografia incompleta ou ilegível pode não ser suficiente.

Sempre que possível, deve-se enviar o arquivo digital original ou uma cópia completa e legível.$faq$, 1630),
  ($faq$E se eu não tiver algum dos documentos solicitados?$faq$, $faq$Se você não possuir algum documento, informe a equipe antes de tentar providenciá-lo por conta própria.

Dependendo do documento e da etapa do processo, pode ser possível:

- orientar onde e como obtê-lo;
- utilizar outro documento equivalente;
- solicitar uma segunda via ou versão atualizada;
- seguir com outras etapas enquanto o documento é providenciado;
- ou identificar se o documento realmente é necessário para aquele caso.

O mais importante é informar a situação. A equipe poderá avaliar a necessidade do documento e orientar qual é o próximo passo adequado.$faq$, 1640),
  ($faq$Como sei se um documento solicitado é realmente necessário para o meu processo?$faq$, $faq$A documentação necessária pode variar conforme o tipo de imóvel, projeto, etapa do processo e órgão responsável.

Quando um documento for solicitado, a equipe poderá orientar:

- qual é a finalidade do documento;
- quem deve fornecê-lo ou emiti-lo;
- em qual etapa ele será utilizado;
- se existe algum prazo ou validade;
- e se há alguma alternativa aceita pelo órgão responsável.

*Se você não souber qual é o documento ou não o possuir, não é necessário providenciá-lo por conta própria antes de entender sua finalidade. A equipe poderá orientar o caminho adequado para cada situação.*$faq$, 1650)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 140 and archived_at is null), q, a, o from (values
  ($faq$Posso protocolar e corrigir depois?$faq$, $faq$Nem sempre.

Depois do protocolo, o processo passa a ser analisado com base nas informações apresentadas.

Dependendo da alteração, pode ser necessário:

- corrigir documentos;
- substituir projetos;
- responder exigência;
- realizar novo protocolo;
- pagar nova taxa;
- reiniciar determinada etapa.

Protocolar rapidamente não significa necessariamente protocolar corretamente.$faq$, 1660),
  ($faq$Se o documento estiver antigo, posso utilizá-lo?$faq$, $faq$Depende do documento e do processo. Devem ser verificadas:

- data de emissão;
- validade;
- atualidade das informações;
- alterações ocorridas no imóvel;
- exigências do órgão;
- necessidade de documento recente.

Documento antigo não deve ser automaticamente descartado, mas também não deve ser automaticamente aceito.$faq$, 1670),
  ($faq$O que devo fazer quando encontrar uma informação divergente?$faq$, $faq$Não devemos assumir qual informação está correta.

Primeiro é necessário:

1. identificar a divergência;
2. registrar a informação;
3. verificar os documentos envolvidos;
4. identificar a origem;
5. avaliar o impacto no projeto;
6. definir o procedimento adequado;
7. somente então prosseguir.

Exemplos de divergência:

- área;
- medidas;
- proprietário;
- endereço;
- lote;
- quadra;
- confrontantes;
- informações cadastrais.$faq$, 1680)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 150 and archived_at is null), q, a, o from (values
  ($faq$O que preciso fazer como cliente?$faq$, $faq$O cliente contribui para o andamento do processo principalmente por meio de:

- fornecimento dos documentos;
- informações corretas sobre o imóvel;
- aprovação de decisões;
- definição de informações necessárias;
- contratação de serviços não incluídos no escopo;
- pagamento das despesas sob sua responsabilidade;
- atendimento às solicitações dentro dos prazos necessários.

*A participação do cliente é parte importante para manter o processo em andamento.*$faq$, 1690),
  ($faq$O que é responsabilidade da equipe?$faq$, $faq$Conforme o serviço contratado, a equipe pode ser responsável por:

- analisar a documentação recebida;
- orientar sobre informações necessárias;
- desenvolver os serviços contratados;
- compatibilizar informações;
- preparar documentação;
- protocolar;
- acompanhar a tramitação;
- analisar exigências;
- orientar sobre providências necessárias.

As responsabilidades exatas devem seguir o escopo definido na contratação.$faq$, 1700),
  ($faq$O que é responsabilidade da Prefeitura ou do órgão responsável?$faq$, $faq$Cabe ao órgão, dentro de suas atribuições:

- receber o processo;
- realizar a análise;
- solicitar complementações;
- emitir pareceres;
- aprovar ou indeferir;
- emitir documentos, licenças ou autorizações quando aplicável.

Cada etapa possui um responsável. Entender essa divisão ajuda a acompanhar o processo com mais clareza.$faq$, 1710),
  ($faq$Quem devo procurar quando tiver uma dúvida?$faq$, $faq$A dúvida deve ser direcionada à equipe (coordenação ou colaborador responsável de cada setor) pelo processo ou ao profissional que possui competência sobre o assunto específico.

*Ter dúvida não é um problema. O importante é não avançar com uma informação que ainda não foi validada.*$faq$, 1720)
) v(q, a, o);

insert into public.faq_items (category_id, question, answer, sort_order)
select (select id from public.faq_categories where sort_order = 160 and archived_at is null), q, a, o from (values
  ($faq$O que posso fazer para meu processo andar mais rápido?$faq$, $faq$A melhor forma de contribuir é evitar que o processo precise parar para corrigir informações que poderiam ter sido conferidas anteriormente.

Para isso:

- envie documentos completos e legíveis;
- forneça informações verdadeiras e atualizadas;
- comunique alterações no imóvel;
- informe mudanças desejadas no projeto;
- responda às solicitações dentro dos prazos;
- não ignore divergências;
- mantenha os dados do proprietário atualizados;
- confirme decisões importantes antes do desenvolvimento;
- providencie documentos e taxas sob sua responsabilidade.

*Um processo bem preparado desde o início tende a ter menos interrupções, retrabalho e necessidade de correções durante sua tramitação.*$faq$, 1730)
) v(q, a, o);
