// Supabase simulado para PREVIEW VISUAL local (scripts/preview). Nunca é usado no build de produção.
// Escolha o perfil com ?as=global_admin | unit_admin | leader | clt | pj | client | empty
/* eslint-disable @typescript-eslint/no-explicit-any */
import FAQ_RAW from "./faq-data.json";

const today = new Date();
const d = (offset: number) => {
  const x = new Date(today); x.setDate(x.getDate() + offset);
  return x.toISOString().slice(0, 10);
};

const HQ = "00000000-0000-4000-8000-000000000001";
const POCOS = "00000000-0000-4000-8000-0000000000a1";
const CAMPINAS = "00000000-0000-4000-8000-0000000000b1";

// Dúvidas frequentes (mesmo conteúdo do FAQ YouCon semeado no banco)
const FAQ_CATS: any[] = (FAQ_RAW as any[]).map((c, i) => ({ id: `fc-${i}`, title: c.title, sort_order: (i + 1) * 10, archived_at: null }));
const FAQ_ITEMS: any[] = (FAQ_RAW as any[]).flatMap((c, i) => c.items.map((it: any) => ({
  id: `fi-${it.n}`, category_id: `fc-${i}`, question: it.q, answer: it.a, keywords: null, sort_order: it.n * 10, archived_at: null, updated_at: "2026-10-08T12:00:00Z",
})));
const FAQ_FB: any[] = [
  { id: "fb-1", item_id: null, helpful: false, query: "consigo pagar a taxa parcelado?", created_at: "2026-10-07T14:10:00Z" },
  { id: "fb-2", item_id: "fi-110", helpful: false, query: "recebi um comunique-se da prefeitura", created_at: "2026-10-06T19:22:00Z" },
  { id: "fb-3", item_id: "fi-131", helpful: true, query: "quanto tempo demora a aprovação", created_at: "2026-10-06T11:05:00Z" },
  { id: "fb-4", item_id: null, helpful: false, query: "vocês fazem projeto de piscina?", created_at: "2026-10-05T09:40:00Z" },
  { id: "fb-5", item_id: "fi-128", helpful: true, query: "quem paga as taxas", created_at: "2026-10-04T16:30:00Z" },
];

// Aprovações e comissões
const APR_TYPES: any[] = [
  ["prefeitura", "Prefeitura", "Aprovação / Projeto Legal"], ["condominio", "Condomínio", "Aprovação / Projeto Legal"],
  ["terraplanagem", "Terraplanagem", "Aprovação de Terraplanagem"], ["demolicao", "Projeto de Demolição", "Aprovação de Projeto de Demolição"],
  ["regularizacao_terreno", "Regularização de Terreno", "Regularização de Terreno"], ["supressao_vegetal", "Supressão Vegetal", "Supressão Vegetal"],
  ["cindacta", "CINDACTA", "Aprovação CINDACTA"], ["vigilancia_sanitaria", "Vigilância Sanitária", "Trâmites de Vigilância Sanitária"],
  ["ligacoes", "Ligação de Água, Energia e Esgoto", "Ligação de Água, Energia e Esgoto"], ["pgr", "PGR", "PGR"],
].map(([code, name, service], i) => ({ id: `at-${code}`, code, name, service, sort_order: (i + 1) * 10 }));
const APR_RATES: Record<string, number | null> = { prefeitura: 800, condominio: 400, terraplanagem: 350, demolicao: 300, cindacta: 450, vigilancia_sanitaria: 500 };
const APR_PROJ: Record<string, string[]> = {
  pr1: ["prefeitura", "condominio", "terraplanagem"], pr2: ["prefeitura", "cindacta", "vigilancia_sanitaria"], pr3: ["prefeitura", "pgr", "ligacoes"],
};
const APR_PNAME: Record<string, [string, string, string]> = {
  pr1: ["Residência Souza", "YC-2026-0014", "Fernanda Souza"], pr2: ["Edifício Horizonte", "YC-2026-0017", "Construtora Horizonte"],
  pr3: ["Clínica Vida", "YC-2026-0019", "Clínica Vida Ltda."], pr4: ["Casa Moreira", "YC-2026-0011", "Paulo Moreira"], pr5: ["Loja Central", "YC-2026-0009", "Grupo Central"],
};
const aprPerson = (id: string, name: string) => ({ id, name, avatar_url: null, employment_type: id.includes("pj") ? "pj" : "clt" });
let APPROVALS: any[] = [
  ["ap1", "pr1", "prefeitura", -3, "PMPC 2231/2026", "awaiting_review", aprPerson("p-c2", "Lucas Ferreira"), 800],
  ["ap2", "pr2", "prefeitura", -9, "SEPLAN 88213", "to_release", aprPerson("p-c2", "Lucas Ferreira"), 800],
  ["ap3", "pr2", "cindacta", -12, "COMAER 4410", "to_release", aprPerson("p-pj2", "Eduardo Prado"), 450],
  ["ap4", "pr3", "prefeitura", -20, null, "released", aprPerson("p-c1", "Beatriz Nogueira"), 800],
  ["ap5", "pr4", "condominio", -26, "Cond. Jardins 12", "paid", aprPerson("p-c2", "Lucas Ferreira"), 400],
  ["ap6", "pr5", "vigilancia_sanitaria", -5, "VISA 0098", "proof_rejected", aprPerson("p-pj2", "Eduardo Prado"), 500],
  ["ap7", "pr4", "terraplanagem", -1, null, "awaiting_review", aprPerson("p-pj2", "Eduardo Prado"), null],
].map(([id, project_id, code, ago, protocol_number, status, recipient, amount]: any) => {
  const ty = APR_TYPES.find((t) => t.code === code)!;
  const [project_name, project_code, client_name] = APR_PNAME[project_id];
  return {
    id, project_id, tenant_id: HQ, tenant_name: "YouCon Franqueadora", project_name, project_code, client_name,
    type_id: ty.id, type_name: ty.name, type_code: code, protocol_number, approved_on: d(ago), notes: null,
    proof: { path: `${project_id}/${id}/x.pdf`, name: `aprovacao-${code}.pdf`, size: 220000, type: "application/pdf" },
    status, review_note: status === "proof_rejected" ? "O arquivo é o protocolo de entrada, não a aprovação. Envie o alvará." : null, cancel_note: null,
    registered_at: d(ago) + "T15:20:00Z", registered_by: { id: recipient.id, name: recipient.name },
    reviewed_at: ["to_release", "released", "paid", "proof_rejected"].includes(status) ? d(ago + 1) + "T10:00:00Z" : null,
    reviewed_by: ["to_release", "released", "paid", "proof_rejected"].includes(status) ? { id: "p-ld", name: "Rafael Andrade" } : null,
    released_at: ["released", "paid"].includes(status) ? d(ago + 2) + "T11:00:00Z" : null,
    paid_at: status === "paid" ? d(-2) + "T09:00:00Z" : null,
    recipient, amount,
  };
});
let APR_INCLUDED: Record<string, string[]> = { pr1: ["terraplanagem"], pr2: ["cindacta", "vigilancia_sanitaria"], pr3: ["pgr", "ligacoes"] };
function aprFlags(a: any) {
  const p = me(); const admin = ["global_admin", "unit_admin"].includes(p?.role); const lead = p?.id === "p-ld";
  return { ...a, amount: admin || lead ? a.amount : null, can_admin: admin, can_review: a.status === "awaiting_review" && (admin || lead),
    can_resubmit: a.status === "proof_rejected" && p?.role !== "client" };
}
function aprBoard(pid: string) {
  const p = me(); const manager = ["global_admin", "unit_admin", "leader"].includes(p?.role);
  const codes = APR_PROJ[pid] ?? ["prefeitura", "condominio"];
  return {
    can_register: p?.role !== "client" && p?.role !== "customer_success", can_include: manager,
    protocols: codes.map((code) => {
      const ty = APR_TYPES.find((t) => t.code === code)!;
      const a = APPROVALS.find((x) => x.project_id === pid && x.type_code === code && x.status !== "cancelled");
      return { type_id: ty.id, type_code: code, type_name: ty.name, sort_order: ty.sort_order, project_service_id: `ps-${code}`, service_name: ty.service,
        task_id: null, task_status: null, approval_id: a?.id ?? null, approval_status: a?.status ?? null };
    }),
    approvals: APPROVALS.filter((x) => x.project_id === pid && x.status !== "cancelled").map(aprFlags),
    tramites: APR_TYPES.filter((t) => !["prefeitura", "condominio"].includes(t.code))
      .map((t) => ({ service_id: `svc-${t.code}`, name: t.service, included: (APR_INCLUDED[pid] ?? []).includes(t.code) })),
  };
}

// Customer Success
const hAgo = (h: number) => new Date(Date.now() - h * 36e5).toISOString();
const hIn = (h: number) => new Date(Date.now() + h * 36e5).toISOString();
const CS_PNAME: Record<string, [string, string, string]> = {
  pr1: ["Residência Souza", "YC-2026-0014", "Fernanda Souza"], pr2: ["Edifício Horizonte", "YC-2026-0017", "Construtora Horizonte"],
  pr3: ["Clínica Vida", "YC-2026-0019", "Clínica Vida Ltda."], pr4: ["Casa Moreira", "YC-2026-0011", "Paulo Moreira"],
};
const ld = { id: "p-ld", name: "Rafael Andrade", avatar_url: null };
const csBy = { id: "p-cs", name: "Juliana Martins" };
let CS_REQ: any[] = [
  { id: "cs1", project_id: "pr2", kind: "alert", urgency: "urgent", title: "Cliente sem retorno sobre a prefeitura há 10 dias",
    body: "A construtora ligou duas vezes hoje. Querem saber se o protocolo foi feito e quando sai a aprovação. Estão bem insatisfeitos.",
    task: { id: "t3", name: "Aprovação ou Alvará", status: "waiting_third_party", planned_end_date: d(12) },
    status: "open", due_at: hAgo(1), created_at: hAgo(5), first_response_at: null, thread: [] },
  { id: "cs2", project_id: "pr1", kind: "client_question", urgency: "high", title: "Quando a cliente recebe o Estudo Preliminar?",
    body: "A Fernanda perguntou se o Estudo Preliminar ainda sai nesta semana, porque ela viaja na sexta.",
    task: { id: "t1", name: "Estudo Preliminar", status: "in_progress", planned_end_date: d(-4) },
    status: "answered", due_at: hIn(20), created_at: hAgo(26), first_response_at: hAgo(22),
    thread: [{ id: "m1", body: "Estamos finalizando as plantas. Entregamos na quinta até as 17h; já combinei com a Beatriz.", created_at: hAgo(22), author: { ...ld, role: "leader" } }] },
  { id: "cs3", project_id: "pr3", kind: "clarification", urgency: "normal", title: "Status do Envio do Briefing",
    body: "O cliente diz que já mandou o briefing por e-mail. Podem confirmar se recebemos e se a etapa pode andar?",
    task: { id: "t4", name: "Envio do Briefing", status: "waiting_client", planned_end_date: d(2) },
    status: "open", due_at: hIn(30), created_at: hAgo(3), first_response_at: null, thread: [] },
  { id: "cs4", project_id: "pr4", kind: "client_question", urgency: "normal", title: "Cliente quer incluir uma suíte no projeto",
    body: "Paulo perguntou se ainda dá para incluir uma suíte no pavimento superior e se isso muda o prazo.",
    task: null, status: "resolved", due_at: hAgo(60), created_at: hAgo(100), first_response_at: hAgo(80), resolved_at: hAgo(70),
    thread: [{ id: "m2", body: "Dá sim. Vira um pedido de ajuste de complexidade média: +7 dias úteis. Já abri o pedido.", created_at: hAgo(80), author: { ...ld, role: "leader" } },
             { id: "m3", body: "Perfeito, vou explicar para ele. Obrigada!", created_at: hAgo(72), author: { id: "p-cs", name: "Juliana Martins", avatar_url: null, role: "customer_success" } }] },
];
function csJson(r: any) {
  const [project_name, project_code, client_name] = CS_PNAME[r.project_id] ?? ["Projeto", null, null];
  const p = me(); const last = r.thread[r.thread.length - 1];
  return { tenant_id: HQ, project_name, project_code, client_name, created_by: csBy, recipients: [ld], last_reply_at: last?.created_at ?? null,
    resolved_at: null, ...r, messages: r.thread.length,
    last_message: last ? { author: last.author.name, body: last.body.slice(0, 160), at: last.created_at, from_cs: last.author.role === "customer_success" } : null,
    overdue: r.status === "open" && !r.first_response_at && new Date(r.due_at) < new Date(), answered_late: false,
    is_recipient: p?.id === "p-ld", can_close: ["open", "answered"].includes(r.status) && ["customer_success", "leader", "unit_admin", "global_admin"].includes(p?.role),
    can_reopen: ["resolved", "cancelled"].includes(r.status) && ["customer_success", "leader", "unit_admin", "global_admin"].includes(p?.role) };
}
function csDashboard() {
  const list = CS_REQ.filter((r) => r.status !== "cancelled").map(csJson);
  const open = list.filter((r) => ["open", "answered"].includes(r.status));
  const monday = new Date(); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return {
    scope: "network",
    counts: { open: open.length, awaiting_team: list.filter((r) => r.status === "open").length, answered: list.filter((r) => r.status === "answered").length,
      urgent_open: open.filter((r) => r.urgency === "urgent" || r.kind === "alert").length, overdue: list.filter((r) => r.overdue).length, created_month: 9, resolved_month: 6 },
    response: { avg_hours: 3.6, on_time_pct: 86, answered: 14 },
    by_kind: [{ kind: "clarification", open: 1, month: 4 }, { kind: "client_question", open: 1, month: 4 }, { kind: "alert", open: 1, month: 1 }],
    trend: [2, 4, 3, 5, 2, 6, 4, 3].map((n, i) => { const w = new Date(monday); w.setDate(w.getDate() - (7 - i) * 7); return { week: w.toISOString().slice(0, 10), created: n, resolved: Math.max(0, n - 1) }; }),
    attention: open.filter((r) => r.urgency === "urgent" || r.kind === "alert" || r.overdue),
    projects: { active: 9, with_overdue: 3, waiting_client: 2 },
    at_risk: [
      { id: "pr2", name: "Edifício Horizonte", code: "YC-2026-0017", client_name: "Construtora Horizonte", overdue_steps: 2, max_overdue_days: 6, waiting_client: 0, next_due: d(5), open_requests: 1 },
      { id: "pr1", name: "Residência Souza", code: "YC-2026-0014", client_name: "Fernanda Souza", overdue_steps: 1, max_overdue_days: 4, waiting_client: 1, next_due: d(3), open_requests: 1 },
      { id: "pr3", name: "Clínica Vida", code: "YC-2026-0019", client_name: "Clínica Vida Ltda.", overdue_steps: 0, max_overdue_days: null, waiting_client: 1, next_due: d(2), open_requests: 1 },
    ],
    upcoming: [
      [d(1), "pr3", "Renderização", "Design de Interiores", "Beatriz Nogueira", "Clínica Vida", "Clínica Vida Ltda."],
      [d(2), "pr3", "Envio do Briefing", "Design de Interiores", "Beatriz Nogueira", "Clínica Vida", "Clínica Vida Ltda."],
      [d(3), "pr1", "Estudo Preliminar", "Projeto Arquitetônico", "Beatriz Nogueira", "Residência Souza", "Fernanda Souza"],
      [d(6), "pr2", "Projeto Legal", "Aprovação / Projeto Legal", "Lucas Ferreira", "Edifício Horizonte", "Construtora Horizonte"],
      [d(9), "pr1", "Projeto de Interiores", "Design de Interiores", "Lucas Ferreira", "Residência Souza", "Fernanda Souza"],
      [d(12), "pr2", "Cálculo estrutural", "Projeto Estrutural", "Camila Rocha", "Edifício Horizonte", "Construtora Horizonte"],
    ].map(([date, pid, task, service, responsible, project_name, client_name], i) => ({ task_id: `up${i}`, project_id: pid, project_name, project_code: null, client_name,
      task, service, planned_end_date: date, status: "not_started", responsible })),
  };
}

// NPS
// Entregas e rodadas de revisão
const dAgo = (days: number, h = 10) => { const x = new Date(Date.now() - days * 86400000); x.setHours(h, 0, 0, 0); return x.toISOString(); };
const BEA = { id: "p-c1", name: "Beatriz Nogueira" }, CAM = { id: "p-pj", name: "Camila Rocha" }, LUC = { id: "p-c2", name: "Lucas Ferreira" };
const dfile = (id: string, name: string, size = 4_800_000) => ({ id, kind: "file", name, path: `pr1/v/${id}.${name.split(".").pop()}`, url: null, mime: "application/pdf", size });
const dlink = (id: string, name: string, url: string) => ({ id, kind: "link", name, path: null, url, mime: null, size: null });
const dver = (id: string, kind: string, round: number | null, title: string, days: number, resp: any, files: any[], notes: string | null = null) =>
  ({ id, kind, round, title, notes, created_at: dAgo(days + 1), published_at: days < 0 ? null : dAgo(days), is_draft: days < 0, published_by: days < 0 ? null : resp?.name ?? "Rafael Andrade", responsible: resp, files });
const dreq = (id: string, round: number, days: number, items: string[], answeredDays: number | null, by = "Fernanda Souza", resp: any = BEA, onBehalf = false) =>
  ({ id, round, items, notes: null, on_behalf: onBehalf, requested_by: by, created_at: dAgo(days, 15), answered_at: answeredDays == null ? null : dAgo(answeredDays, 17), answered_version_id: null, version_id: null, responsible: resp, files: [] as any[] });
const dimg = (id: string, name: string) => ({ id, kind: "file", name, path: `pr1/req/x/${id}.jpg`, url: null, mime: "image/jpeg", size: 240_000 });
let DLV: Record<string, any> = {
  "ps-arq": { name: "Projeto Arquitetônico", area: "architecture", sort: 10, enabled: true, included: 3, approvedAt: null, approvedBy: null, onBehalf: false, note: null, resp: BEA,
    versions: [
      dver("v-arq-1", "revision", 1, "Revisão 1", 2, BEA, [dfile("f1", "Planta baixa R1.pdf"), dfile("f2", "Cortes e fachadas R1.pdf", 6_200_000), dlink("f3", "Imagens 3D", "https://drive.google.com/drive/folders/abc")],
        "Ampliamos a suíte principal e trocamos o revestimento da fachada conforme o pedido."),
      dver("v-arq-0", "presentation", 0, "Apresentação preliminar", 16, BEA, [dfile("f4", "Estudo preliminar.pdf", 9_100_000), dlink("f5", "Vídeo de apresentação", "https://drive.google.com/file/d/xyz")]),
    ],
    requests: [{ ...dreq("r-arq-1", 1, 9, ["Aumentar a suíte principal em 1 metro", "Trocar o revestimento da fachada por pedra natural", "Incluir uma despensa na cozinha"], 2),
      files: [dimg("a1", "Print da planta.png"), dimg("a2", "Inspiração fachada.jpg"), dimg("a3", "Referência despensa.jpg"), dfile("a4", "Medidas do terreno.pdf", 900_000)] }],
    extras: [] },
  "ps-est": { name: "Projeto Estrutural", area: "engineering", sort: 20, enabled: true, included: 3, approvedAt: null, approvedBy: null, onBehalf: false, note: null, resp: CAM,
    versions: [
      dver("v-est-d", "revision", 1, "Revisão 1", -1, CAM, [dfile("f6", "Formas pavimento térreo R1.pdf", 3_200_000)]),
      dver("v-est-0", "presentation", 0, "Apresentação preliminar", 12, CAM, [dfile("f7", "Lançamento estrutural.pdf", 5_400_000)]),
    ],
    requests: [{ ...dreq("r-est-1", 1, 5, ["Eliminar o pilar no meio da sala de estar", "Avaliar laje para caixa d'água de 1.000 litros"], null, "Rafael Andrade", CAM, true),
      files: [dimg("a5", "Print do WhatsApp.png"), dimg("a6", "Referência sala sem pilar.jpg")] }],
    extras: [] },
  "ps-int": { name: "Design de Interiores", area: "architecture", sort: 30, enabled: true, included: 3, approvedAt: dAgo(12), approvedBy: "Fernanda Souza", onBehalf: false, note: "Ficou lindo, podem seguir!", resp: LUC,
    versions: [
      dver("v-int-f", "final", null, "Projeto final", 3, LUC, [dfile("f8", "Detalhamento marcenaria.pdf", 12_000_000), dfile("f9", "Paginação de pisos.pdf"), dlink("f10", "Renders finais", "https://drive.google.com/drive/folders/int")],
        "Projeto executivo de interiores completo. Qualquer dúvida estamos à disposição."),
      dver("v-int-4", "revision", 4, "Revisão 4", 14, LUC, [dfile("f11", "Layout R4.pdf")]),
      dver("v-int-3", "revision", 3, "Revisão 3", 20, LUC, [dfile("f12", "Layout R3.pdf")]),
      dver("v-int-2", "revision", 2, "Revisão 2", 26, LUC, [dfile("f13", "Layout R2.pdf")]),
      dver("v-int-1", "revision", 1, "Revisão 1", 32, LUC, [dfile("f14", "Layout R1.pdf")]),
      dver("v-int-0", "presentation", 0, "Apresentação preliminar", 40, LUC, [dfile("f15", "Layout e modelagem.pdf")]),
    ],
    requests: [dreq("r-int-1", 1, 36, ["Trocar o sofá por um modelo em L"], 32, "Fernanda Souza", LUC), dreq("r-int-2", 2, 30, ["Mudar a cor da marcenaria da cozinha"], 26, "Fernanda Souza", LUC),
      dreq("r-int-3", 3, 24, ["Incluir nicho no banheiro social"], 20, "Fernanda Souza", LUC), dreq("r-int-4", 4, 17, ["Ajustar a iluminação da sala"], 14, "Fernanda Souza", LUC)],
    extras: [{ id: "x-int-1", kind: "courtesy", status: "approved", created_at: dAgo(18), decided_at: dAgo(18, 11), reason: "Ajuste pequeno de iluminação; evitar desgaste com a cliente", amount: null, decision_note: null, requested_by: "Lucas Ferreira", decided_by: "Rafael Andrade" }] },
  "ps-ele": { name: "Projeto Elétrico", area: "engineering", sort: 40, enabled: true, included: 3, approvedAt: null, approvedBy: null, onBehalf: false, note: null, resp: CAM, versions: [], requests: [], extras: [] },
  general: { name: "Documentos do projeto", area: null, sort: 99, enabled: false, included: 0, approvedAt: null, approvedBy: null, onBehalf: false, note: null, resp: null,
    versions: [dver("v-gen-0", "document", null, "Documentos do terreno", 30, null, [dfile("f16", "Matrícula do imóvel.pdf", 800_000), dfile("f17", "IPTU 2026.pdf", 400_000)])],
    requests: [], extras: [] },
};
function dlvCalc(it: any) {
  const pub = it.versions.filter((v: any) => !v.is_draft);
  const lc = pub.filter((v: any) => v.kind === "presentation" || v.kind === "revision").sort((a: any, b: any) => b.published_at.localeCompare(a.published_at))[0];
  const lf = pub.filter((v: any) => v.kind === "final" || v.kind === "document").sort((a: any, b: any) => b.published_at.localeCompare(a.published_at))[0];
  const open = it.requests.find((r: any) => !r.answered_at) ?? null;
  const allowed = it.included + it.extras.filter((e: any) => e.status === "approved").length;
  const status = !it.enabled ? (lf ? "delivered" : "in_production") : it.approvedAt && lf ? "final" : it.approvedAt ? "detailing" : open ? "revision_requested" : lc ? "awaiting_client" : "in_production";
  return { lc, lf, open, allowed, used: it.requests.length, status };
}
function dlvItem(key: string, staff: boolean) {
  const it = DLV[key]; const c = dlvCalc(it);
  const p = me(); const lead = ["global_admin", "unit_admin"].includes(p?.role) || p?.id === "p-ld";
  return { key, project_service_id: key === "general" ? null : key, delivery_id: `d-${key}`, name: it.name, area: it.area, sort: it.sort,
    revisions_enabled: it.enabled, included: it.included, allowed: c.allowed, used: c.used, status: c.status,
    creation_approved_at: it.approvedAt, creation_approved_by: it.approvedBy, approval_on_behalf: it.onBehalf, approval_note: it.note,
    last_creation_version_id: c.lc?.id ?? null, last_final_version_id: c.lf?.id ?? null, has_draft: it.versions.some((v: any) => v.is_draft),
    open_request: c.open ? { ...c.open, responsible: staff ? c.open.responsible : null } : null,
    requests: [...it.requests].sort((a: any, b: any) => a.round - b.round).map((r: any) => ({ ...r, responsible: staff ? r.responsible : null })),
    versions: it.versions.filter((v: any) => staff || !v.is_draft).map((v: any) => ({ ...v, responsible: staff ? v.responsible : null })),
    extras: it.extras.filter((e: any) => staff || e.status === "approved").map((e: any) => staff ? e : { ...e, reason: null, amount: null, decision_note: null, requested_by: null, decided_by: null }),
    creation_responsible: staff ? it.resp : null, can_decide_extra: staff && lead };
}
function dlvBoard(projectId: string) {
  const p = me(); const staff = p?.role !== "client";
  const proj = PROJECTS.find((x: any) => x.id === projectId) ?? PROJECTS.find((x: any) => x.id === "pr1");
  return { project: { id: proj.id, name: proj.name, code: proj.code, status: proj.status }, is_client: !staff, is_staff: staff,
    can_work: staff && p?.role !== "customer_success", can_request_extra: staff,
    items: Object.keys(DLV).filter((k) => k !== "general").map((k) => dlvItem(k, staff)), general: dlvItem("general", staff) };
}
const dlvFindVersion = (id: string) => { for (const k of Object.keys(DLV)) { const v = DLV[k].versions.find((x: any) => x.id === id); if (v) return { key: k, it: DLV[k], v }; } return null; };
function dlvAct(fn: string, a: any): any {
  const p = me(); const name = p?.name ?? "Equipe";
  const key = a.p_ps ?? "general"; const it = DLV[key];
  if (fn === "delivery_version_start") {
    const c = dlvCalc(it); const round = a.p_kind === "revision" ? c.open?.round : a.p_kind === "presentation" ? 0 : null;
    const title = a.p_title || (a.p_kind === "presentation" ? "Apresentação preliminar" : a.p_kind === "revision" ? `Revisão ${round}` : a.p_kind === "final" ? "Projeto final" : "Documentos");
    const v = dver("v" + Date.now(), a.p_kind, round, title, -1, it.resp, []); v.notes = a.p_notes; it.versions.unshift(v); return v.id;
  }
  const fv = a.p_version ? dlvFindVersion(a.p_version) : null;
  if (fn === "delivery_version_update" && fv) { Object.assign(fv.v, { title: a.p_title, notes: a.p_notes, responsible: a.p_responsible ? { id: a.p_responsible, name: profiles.find((x) => x.id === a.p_responsible)?.name } : null }); return null; }
  if (fn === "delivery_file_add" && fv) { const f = a.p_kind === "file" ? { ...dfile("f" + Date.now(), a.p_name, a.p_size), path: a.p_path } : dlink("f" + Date.now(), a.p_name || "Link", a.p_url); fv.v.files.push(f); return f.id; }
  if (fn === "delivery_file_remove") { for (const k of Object.keys(DLV)) DLV[k].versions.forEach((v: any) => { v.files = v.files.filter((f: any) => f.id !== a.p_file); }); return null; }
  if (fn === "delivery_version_discard" && fv) { fv.it.versions = fv.it.versions.filter((x: any) => x.id !== fv.v.id); return null; }
  if (fn === "delivery_version_publish" && fv) {
    const c = dlvCalc(fv.it); Object.assign(fv.v, { is_draft: false, published_at: new Date().toISOString(), published_by: name });
    if (fv.v.kind === "revision" && c.open) c.open.answered_at = new Date().toISOString(); return null;
  }
  if (fn === "delivery_request_revision") { const c = dlvCalc(it); it.requests.push({ ...dreq("r" + Date.now(), c.used + 1, 0, a.p_items, null, name, it.resp, p?.role !== "client"),
    files: (a.p_files ?? []).map((f: any, i: number) => ({ id: "na" + i, kind: "file", name: f.name, path: f.path, url: null, mime: f.mime, size: f.size })) }); it.requests[it.requests.length - 1].created_at = new Date().toISOString(); return c.used + 1; }
  if (fn === "delivery_approve") { Object.assign(it, { approvedAt: new Date().toISOString(), approvedBy: name, onBehalf: p?.role !== "client", note: a.p_note }); return null; }
  if (fn === "delivery_extra_request") {
    const auto = ["global_admin", "unit_admin"].includes(p?.role) || p?.id === "p-ld";
    it.extras.unshift({ id: "x" + Date.now(), kind: a.p_kind, status: auto ? "approved" : "pending", created_at: new Date().toISOString(), decided_at: auto ? new Date().toISOString() : null,
      reason: a.p_reason, amount: a.p_amount, decision_note: null, requested_by: name, decided_by: auto ? name : null });
    if (auto) it.approvedAt = null; return "x";
  }
  if (fn === "delivery_extra_decide") {
    for (const k of Object.keys(DLV)) { const e = DLV[k].extras.find((x: any) => x.id === a.p_id); if (e) { Object.assign(e, { status: a.p_approve ? "approved" : "rejected", decided_at: new Date().toISOString(), decided_by: name, decision_note: a.p_note }); if (a.p_approve) DLV[k].approvedAt = null; } }
    return null;
  }
  return null;
}
const DLV_SETTINGS: any[] = [
  ["Arquitetura", "Projeto Arquitetônico", true, 3, ["estudo_preliminar"], [["planejamento", "Planejamento"], ["envio_briefing", "Envio do Briefing"], ["estudo_preliminar", "Estudo Preliminar"], ["alteracoes", "Alterações"], ["imagens_3d_video", "Imagens 3D e Vídeo"]]],
  ["Interiores", "Design de Interiores", true, 3, ["projeto_interiores", "layout_modelagem"], [["layout_modelagem", "Layout + Modelagem"], ["projeto_interiores", "Projeto de Interiores"], ["alteracao", "Alteração"], ["renderizacao", "Renderização"], ["detalhamento", "Detalhamento"]]],
  ["Engenharia", "Projeto Estrutural", true, 3, ["producao_disciplina"], [["producao_disciplina", "Produção da disciplina"], ["compatibilizacao", "Compatibilização"], ["executivo", "Executivo"]]],
  ["Engenharia", "Projeto Elétrico", true, 3, ["producao_disciplina"], [["producao_disciplina", "Produção da disciplina"], ["compatibilizacao", "Compatibilização"], ["executivo", "Executivo"]]],
  ["Engenharia", "Projeto Hidrossanitário", true, 3, ["producao_disciplina"], [["producao_disciplina", "Produção da disciplina"], ["compatibilizacao", "Compatibilização"], ["executivo", "Executivo"]]],
  ["Aprovações", "Aprovação / Projeto Legal", false, 0, [], [["projeto_legal", "Projeto Legal"], ["protocolo", "Protocolo Condomínio ou Prefeitura"]]],
  ["Aprovações", "Aprovação CINDACTA", false, 0, [], [["aprovacao_orgao", "Aprovação CINDACTA"]]],
].map(([family, n, en, inc, codes, opts]: any, i) => ({ id: ({ "Projeto Arquitetônico": "arq", "Design de Interiores": "int", "Projeto Estrutural": "est", "Projeto Elétrico": "ele" } as any)[n] ?? "svc-" + i, name: n, family, area: "architecture", revisions_enabled: en, included_revisions: inc, creation_task_codes: codes,
  task_options: opts.map(([code, nm]: any) => ({ code, name: nm })) }));
const REV_PEOPLE = [
  { id: "p-c2", name: "Lucas Ferreira", avatar_url: null, presentations: 2, revisions: 7, approved: 2, approved_rounds: 8, courtesy: 1, paid: 0 },
  { id: "p-c1", name: "Beatriz Nogueira", avatar_url: null, presentations: 3, revisions: 3, approved: 2, approved_rounds: 3, courtesy: 0, paid: 0 },
  { id: "p-pj", name: "Camila Rocha", avatar_url: null, presentations: 2, revisions: 2, approved: 1, approved_rounds: 1, courtesy: 0, paid: 1 },
  { id: "p-a2", name: "Isadora Lima", avatar_url: null, presentations: 1, revisions: 1, approved: 1, approved_rounds: 1, courtesy: 0, paid: 0 },
  { id: "p-e2", name: "Gabriel Souto", avatar_url: null, presentations: 1, revisions: 0, approved: 1, approved_rounds: 0, courtesy: 0, paid: 0 },
];

// Prazo de retorno do cliente
const isoDay = (n: number) => { const x = new Date(Date.now() + n * 86400000); return x.toISOString().slice(0, 10); };
let CW_SETTINGS: any = { enabled: true, days: 2, documents_days: 5 };
let CWAITS: any[] = [
  { id: "cw1", project_id: "pr1", source: "delivery", label: "Avaliação: Revisão 1 · Projeto Arquitetônico", project_service_id: "ps-arq", task_id: null,
    started_on: isoDay(-6), due_on: isoDay(-4), returned_on: null, close_source: null, state: "late", late_days: 3, waived_until: null, waive_reason: null,
    returned_note: null, returned_by: null, project_name: "Residência Souza", project_code: "YC-2026-0014", client_name: "Fernanda Souza" },
  { id: "cw2", project_id: "pr1", source: "documents", label: "Envio dos documentos obrigatórios", project_service_id: null, task_id: null,
    started_on: isoDay(-1), due_on: isoDay(2), returned_on: null, close_source: null, state: "open", late_days: 0, waived_until: null, waive_reason: null,
    returned_note: null, returned_by: null, project_name: "Residência Souza", project_code: "YC-2026-0014", client_name: "Fernanda Souza" },
  { id: "cw3", project_id: "pr1", source: "delivery", label: "Avaliação: Apresentação preliminar · Design de Interiores", project_service_id: "ps-int", task_id: null,
    started_on: isoDay(-40), due_on: isoDay(-37), returned_on: isoDay(-36), close_source: "portal", state: "closed", late_days: 1, waived_until: null, waive_reason: null,
    returned_note: null, returned_by: "Fernanda Souza", project_name: "Residência Souza", project_code: "YC-2026-0014", client_name: "Fernanda Souza" },
];
const cwFor = (w: any, staff: boolean) => {
  const pr = me(); const lead = ["global_admin", "unit_admin"].includes(pr?.role) || pr?.id === "p-ld";
  return { ...w, can_return: staff && w.state !== "closed" && w.source !== "documents" && (lead || pr?.id === "p-c1"), can_waive: staff && w.state !== "closed" && lead,
    waive_reason: staff ? w.waive_reason : null, returned_note: staff ? w.returned_note : null, returned_by: staff ? w.returned_by : null };
};

// Documentos do cliente
let DOC_SECTIONS: any[] = [
  { id: "ds1", name: "Documentação do proprietário", sort_order: 10 },
  { id: "ds2", name: "Documentação do imóvel e comprovação da propriedade", sort_order: 20 },
  { id: "ds3", name: "Levantamento topográfico e informações técnicas do terreno", sort_order: 30 },
  { id: "ds4", name: "Documentação para aprovação em condomínio", sort_order: 40 },
];
let DOC_QUESTIONS: any[] = [{ id: "dq1", text: "O imóvel fica em condomínio?", help: null }];
let DOC_ANSWER: boolean | null = null;
let DOCS_WAIT = true;
let DOC_TYPES: any[] = [
  { id: "dt1", section_id: "ds1", holder: "pf", name: "RG ou CNH do proprietário", description: null },
  { id: "dt2", section_id: "ds1", holder: "pf", name: "Comprovante de endereço atualizado", description: null },
  { id: "dt3", section_id: "ds1", holder: "pj", name: "Cartão CNPJ atualizado", description: null },
  { id: "dt4", section_id: "ds1", holder: "pj", name: "Contrato social e últimas alterações contratuais, ou consolidação contratual", description: null },
  { id: "dt5", section_id: "ds1", holder: "pj", name: "Documento de identificação e CPF do representante legal", description: null },
  { id: "dt6", section_id: "ds2", name: "Matrícula atualizada do imóvel", description: null },
  { id: "dt7", section_id: "ds2", name: "IPTU", description: null },
  { id: "dt8", section_id: "ds3", name: "Levantamento planialtimétrico ou planialtimétrico cadastral", description: "Assinado pelo profissional responsável e pelo proprietário." },
  { id: "dt9", section_id: "ds3", name: "Arquivo editável do levantamento (DWG)", description: "Arquivo editável do levantamento topográfico, como DWG." },
  { id: "dt10", section_id: "ds3", name: "ART ou RRT do levantamento", description: "Referente ao levantamento topográfico." },
  { id: "dt11", section_id: "ds4", question_id: "dq1", name: "Convenção de condomínio ou regulamento interno", description: "Convenção ou regulamento interno pertinente à construção." },
  { id: "dt12", section_id: "ds4", question_id: "dq1", name: "Regulamento ou manual de obras", description: null },
  { id: "dt13", section_id: "ds4", question_id: "dq1", name: "Diretrizes e padrões construtivos do condomínio", description: null },
].map((t, i) => ({ holder: null, question_id: null, service_codes: null, required: true, ...t, sort_order: (i + 1) * 10 }));
const docFile = (id: string, name: string, kind = "file", extra: any = {}) => ({ id, round: 1, kind, name, path: kind === "file" ? `pr1/x/${id}.pdf` : null, mime: "application/pdf",
  size: kind === "file" ? 812000 : null, url: kind === "link" ? "https://drive.google.com/drive/folders/abc" : null, created_at: isoDay(-3) + "T14:20:00Z", on_behalf: false, by: "Fernanda Souza", mine: true, ...extra });
let DOCS: any[] = [
  { id: "d1", type: "dt1", status: "approved", files: [docFile("f1", "cnh-fernanda.pdf")], reviewed_by: "Beatriz Nogueira", reviewed_at: isoDay(-2) + "T10:00:00Z", submitted_at: isoDay(-3) + "T14:20:00Z" },
  { id: "d2", type: "dt2", status: "submitted", files: [docFile("f2", "conta-de-luz.jpg")], submitted_at: isoDay(-1) + "T09:12:00Z" },
  { id: "d3", type: "dt6", status: "approved", files: [docFile("f3", "matricula-12345.pdf")], reviewed_by: "Beatriz Nogueira", reviewed_at: isoDay(-2) + "T10:00:00Z" },
  { id: "d4", type: "dt7", status: "pending", files: [] },
  { id: "d5", type: "dt8", status: "rejected", round: 2, files: [], history: [docFile("f4", "topografico.pdf")], reject_reason: "O levantamento veio sem a assinatura do proprietário. Envie a versão assinada pelos dois.",
    reviewed_by: "Beatriz Nogueira", reviewed_at: isoDay(-1) + "T16:00:00Z" },
  { id: "d6", type: "dt9", status: "pending", files: [] },
  { id: "d7", type: "dt10", status: "pending", files: [] },
  { id: "d9", source: "extra", name: "Certidão de uso do solo", description: "Exigida pela prefeitura para o alvará. Peça no setor de urbanismo.", required: false, status: "pending", files: [],
    requested_by: "Ana Paula Martins", created_at: isoDay(-1) },
];
let DOCS_REMOVED: any[] = [{ id: "d8", source: "standard", name: "Projeto aprovado anterior", description: null, required: false, status: "pending", removed_reason: "Terreno sem construção anterior", files: [], history: [] }];
const docJson = (d: any, staff: boolean) => {
  const t = DOC_TYPES.find((x) => x.id === d.type);
  return { id: d.id, source: d.source ?? "standard", name: d.name ?? t?.name, description: d.description ?? t?.description ?? null, required: d.required ?? t?.required ?? false,
    section: t ? DOC_SECTIONS.find((x) => x.id === t.section_id)?.name ?? null : null,
    status: d.status, round: d.round ?? 1, reject_reason: d.reject_reason ?? null, submitted_at: d.submitted_at ?? null, reviewed_at: d.reviewed_at ?? null,
    reviewed_by: staff ? d.reviewed_by ?? null : null, requested_by: staff ? d.requested_by ?? null : null, created_at: d.created_at ?? isoDay(-10),
    removed_at: d.removed_reason ? isoDay(-2) : null, removed_reason: staff ? d.removed_reason ?? null : null, removed_auto: false,
    files: (d.files ?? []).map((f: any) => ({ ...f, by: staff ? f.by : null })), history: d.history ?? [] };
};
const docList = () => {
  const cond = DOC_ANSWER ? DOC_TYPES.filter((t) => t.question_id === "dq1").map((t) => ({ id: `dc-${t.id}`, type: t.id, status: "pending", files: [] })) : [];
  const std = [...DOCS.filter((d) => d.type), ...cond.filter((c) => !DOCS.some((d) => d.type === c.type))];
  const order = (d: any) => { const t = DOC_TYPES.find((x) => x.id === d.type); const sec = DOC_SECTIONS.find((x) => x.id === t?.section_id); return (sec?.sort_order ?? 0) * 1000 + (t?.sort_order ?? 0); };
  return [...std.sort((a, b) => order(a) - order(b)), ...DOCS.filter((d) => !d.type)];
};
const docProgress = () => {
  const items = docList().map((d) => docJson(d, true));
  const c = (st: string) => items.filter((d) => d.status === st).length;
  const req = items.filter((d) => d.required);
  return { total: items.length, approved: c("approved"), submitted: c("submitted"), rejected: c("rejected"), pending: c("pending"),
    required_total: req.length, required_sent: req.filter((d) => d.status === "submitted" || d.status === "approved").length,
    percent: items.length ? Math.round((100 * c("approved")) / items.length) : null };
};
const docBoard = () => {
  const pr = me(); const staff = pr?.role !== "client"; const lead = ["global_admin", "unit_admin", "leader"].includes(pr?.role);
  const w = CWAITS.find((x) => x.source === "documents" && x.state !== "closed");
  return { project: { id: "pr1", name: "Residência Souza", code: "YC-2026-0014", status: "in_progress" }, is_client: !staff, is_staff: staff,
    can_upload: true, can_review: staff, can_manage: staff && lead, progress: docProgress(), wait: w ? cwFor(w, staff) : null, documents_days: CW_SETTINGS.documents_days,
    holder: "pf", documents_wait: DOCS_WAIT,
    questions: DOC_QUESTIONS.map((q) => ({ ...q, required: true, answer: DOC_ANSWER, answered_at: DOC_ANSWER === null ? null : isoDay(0), answered_by: DOC_ANSWER === null ? null : "Fernanda Souza", can_answer: true })),
    items: docList().map((d) => docJson(d, staff)), removed: staff ? DOCS_REMOVED.map((d) => ({ ...docJson(d, true), removed_at: isoDay(-2) })) : [] };
};

// Acessos do cliente por projeto
let CACCESS: any[] = [
  { id: "ca1", profile_id: "p-cl", name: "Fernanda Souza", email: "fernanda@email.com", relation: "Proprietária", scope: "all", can_decide: true, is_primary: true, status: "active", projects: null, invited_by: null },
  { id: "ca2", profile_id: "pc2", name: "Marcos Souza", email: "marcos.souza@email.com", relation: "Cônjuge", scope: "all", can_decide: true, is_primary: false, status: "active", projects: null, invited_by: "Fernanda Souza" },
  { id: "ca3", profile_id: "pc3", name: "Juliana Prado", email: "juliana@pradoarq.com.br", relation: "Arquiteta parceira", scope: "projects", can_decide: false, is_primary: false, status: "pending", projects: 1, invited_by: "Rafael Andrade" },
];
const caccessBoard = () => {
  const pr = me(); const client = pr?.role === "client"; const manage = !client || pr?.id === "p-cl";
  return { project: { id: "pr1", name: "Residência Souza", client_name: "Fernanda Souza" }, can_manage: manage, can_grant_all: manage, other_projects: 1,
    people: CACCESS.map((x) => ({ ...x, email: manage || x.profile_id === pr?.id ? x.email : null, is_me: x.profile_id === pr?.id,
      can_edit: manage && x.profile_id !== pr?.id && (!client || !x.is_primary) })) };
};

// "Preciso de ajuda"
const SUPPORT_TPL = "Olá, {lider}! Aqui é {cliente}, do projeto {projeto}. Estou precisando de uma ajuda sobre {assunto}. {mensagem} Consegue me ajudar?";
let SUPPORT_CATS: any[] = [
  { id: "sc1", label: "Projeto arquitetônico e interiores", description: "Plantas, layout, acabamentos, imagens 3D", target: "architecture", sort_order: 10, active: true },
  { id: "sc2", label: "Engenharia", description: "Estrutural, elétrico, hidráulico e demais projetos técnicos", target: "engineering", sort_order: 20, active: true },
  { id: "sc3", label: "Aprovação e documentação", description: "Prefeitura, condomínio, órgãos, taxas e documentos", target: "approval", sort_order: 30, active: true },
  { id: "sc4", label: "Prazos e andamento do projeto", description: "Entender em que etapa o projeto está e as próximas entregas", target: "cs", sort_order: 40, active: true },
];
const SUPPORT_PEOPLE: any[] = [
  { id: "p-ua", name: "Mariana Lopes", role: "unit_admin", whatsapp: null, leads: ["engineering"], projects_led: 2 },
  { id: "p-cs", name: "Juliana Martins", role: "customer_success", whatsapp: "5535998887766", leads: [], projects_led: 0 },
  { id: "p-ld", name: "Rafael Andrade", role: "leader", whatsapp: "5535999991111", leads: ["architecture", "approval"], projects_led: 3 },
  { id: "p-ga", name: "Thiago Cardim", role: "global_admin", whatsapp: null, leads: [], projects_led: 0 },
];
let SUPPORT_SETTINGS: any = { cs_whatsapp: "5535998887766", message_template: SUPPORT_TPL };
const tsAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
let SUPPORT_TICKETS: any[] = [
  { id: "st1", project_id: "pr1", project_name: "Residência Souza", project_code: "YC-2026-0014", client_name: "Fernanda Souza",
    requester: { id: "p-cl", name: "Fernanda Souza", phone: "(35) 99876-1234", email: "fernanda.souza@gmail.com" },
    category: "Aprovação e documentação", target: "approval", contact_name: "Rafael Andrade", has_whatsapp: true,
    message: "Queria saber se a prefeitura já pediu alguma correção.", status: "open", cs_note: null, created_at: tsAgo(3), closed_at: null, closed_by: null, tenant_name: "YouCon Franqueadora" },
  { id: "st2", project_id: "pr1", project_name: "Residência Souza", project_code: "YC-2026-0014", client_name: "Fernanda Souza",
    requester: { id: "p-cl", name: "Fernanda Souza", phone: "(35) 99876-1234", email: "fernanda.souza@gmail.com" },
    category: "Engenharia", target: "engineering", contact_name: "Mariana Lopes", has_whatsapp: false,
    message: "A laje da área gourmet aguenta uma caixa d'água?", status: "open", cs_note: null, created_at: tsAgo(26), closed_at: null, closed_by: null, tenant_name: "YouCon Franqueadora" },
  { id: "st3", project_id: "pr2", project_name: "Edifício Aurora", project_code: "YC-2026-0015", client_name: "Construtora Horizonte",
    requester: { id: "p-cl2", name: "Construtora Horizonte", phone: null, email: "obras@horizonte.com.br" },
    category: "Prazos e andamento do projeto", target: "cs", contact_name: "Customer Success", has_whatsapp: true,
    message: null, status: "resolved", cs_note: "Cliente confirmou que recebeu o cronograma atualizado.", created_at: tsAgo(80), closed_at: tsAgo(70), closed_by: { id: "p-cs", name: "Juliana Martins" }, tenant_name: "YouCon Franqueadora" },
  { id: "st4", project_id: "pr1", project_name: "Residência Souza", project_code: "YC-2026-0014", client_name: "Fernanda Souza",
    requester: { id: "p-cl", name: "Fernanda Souza", phone: "(35) 99876-1234", email: "fernanda.souza@gmail.com" },
    category: "Projeto arquitetônico e interiores", target: "architecture", contact_name: "Rafael Andrade", has_whatsapp: true,
    message: "Posso trocar o piso da sala?", status: "unresolved", cs_note: "Líder ainda não retornou sobre a troca de piso.", created_at: tsAgo(150), closed_at: tsAgo(100), closed_by: { id: "p-cs", name: "Juliana Martins" }, tenant_name: "YouCon Franqueadora" },
];
const urlEnc = (t: string) => encodeURIComponent(t).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
function supportOpen(a: any) {
  const c = SUPPORT_CATS.find((x) => x.id === a.p_category);
  const contact = c.target === "architecture" || c.target === "approval" ? SUPPORT_PEOPLE[2] : c.target === "engineering" ? SUPPORT_PEOPLE[0] : null;
  const wa = contact?.whatsapp ?? SUPPORT_SETTINGS.cs_whatsapp;
  const name = contact?.whatsapp ? contact.name : wa ? "Customer Success" : contact?.name ?? null;
  const msg = (a.p_message ?? "").trim();
  const text = SUPPORT_SETTINGS.message_template.replace("{lider}", contact?.whatsapp ? contact.name.split(" ")[0] : "equipe YouCon").replace("{cliente}", "Fernanda")
    .replace("{projeto}", "Residência Souza").replace("{assunto}", c.label.toLowerCase()).replace("{mensagem}", msg ? (/[.!?]$/.test(msg) ? msg : msg + ".") : "").replace(/\s{2,}/g, " ").trim();
  const id = "st" + Date.now();
  SUPPORT_TICKETS.unshift({ id, project_id: a.p_project, project_name: "Residência Souza", project_code: "YC-2026-0014", client_name: "Fernanda Souza",
    requester: { id: "p-cl", name: "Fernanda Souza", phone: "(35) 99876-1234", email: null }, category: c.label, target: c.target, contact_name: name, has_whatsapp: !!wa,
    message: msg || null, status: "open", cs_note: null, created_at: new Date().toISOString(), closed_at: null, closed_by: null, tenant_name: "YouCon Franqueadora" });
  // No preview não abre o WhatsApp de verdade.
  return { id, contact_name: name, has_whatsapp: !!wa, url: wa ? `about:blank#wa.me/${wa}?text=${urlEnc(text)}` : null, text };
}

let NPS_PENDING: any[] = [{ project_service_id: "ps-arq-1", project_id: "pr1", project_name: "Residência Souza", service_name: "Projeto Arquitetônico",
  completed_on: d(-1), question: "De 0 a 10, quanto você recomendaria a YouCon para um amigo ou familiar?" }];
const NPS_ROWS: any[] = [
  [10, "Equipe muito atenciosa, o projeto ficou exatamente como sonhamos.", "Residência Souza", "Fernanda Souza", "Projeto Arquitetônico", -2],
  [9, "Gostei muito das imagens 3D, ajudaram a decidir os acabamentos.", "Casa Moreira", "Paulo Moreira", "Design de Interiores", -6],
  [4, "O prazo atrasou duas vezes e fiquei sabendo só quando perguntei.", "Edifício Horizonte", "Construtora Horizonte", "Projeto Estrutural", -9],
  [8, "Bom trabalho. Poderiam mandar atualizações com mais frequência.", "Clínica Vida", "Clínica Vida Ltda.", "Aprovação / Projeto Legal", -12],
  [10, null, "Loja Central", "Grupo Central", "Projeto Arquitetônico", -15],
  [9, "Rápidos na aprovação da prefeitura.", "Casa Moreira", "Paulo Moreira", "Aprovação / Projeto Legal", -21],
  [7, "Atendimento ok, mas o retorno das dúvidas demorou.", "Residência Lima", "Ana Lima", "Projeto Elétrico", -33],
  [10, "Superou as expectativas!", "Casa Duarte", "Rogério Duarte", "Projeto Arquitetônico", -41],
  [6, "Precisei refazer o briefing duas vezes.", "Studio Bela", "Bela Arquitetura", "Design de Interiores", -48],
  [9, null, "Casa Duarte", "Rogério Duarte", "Projeto Estrutural", -57],
].map(([score, comment, project_name, client_name, service_name, ago]: any, i) => ({
  id: `nps${i}`, score, comment, answered_at: d(ago) + "T14:00:00Z", completed_on: d(ago - 1), project_id: "pr1", project_name, project_code: null,
  client_name, service_name, respondent: client_name, tenant_name: "YouCon Franqueadora",
  category: score >= 9 ? "promoter" : score >= 7 ? "passive" : "detractor" }));
function npsOverview() {
  const r = NPS_ROWS; const prom = r.filter((x) => x.score >= 9).length; const det = r.filter((x) => x.score <= 6).length;
  const by: Record<string, number[]> = {}; r.forEach((x) => (by[x.service_name] ??= []).push(x.score));
  const npsOf = (xs: number[]) => Math.round(100 * (xs.filter((v) => v >= 9).length - xs.filter((v) => v <= 6).length) / xs.length);
  const months = Array.from({ length: 6 }, (_, i) => { const m = new Date(); m.setDate(1); m.setMonth(m.getMonth() - 5 + i); return m.toISOString().slice(0, 7) + "-01"; });
  const series = [[3, 33], [4, 50], [2, 0], [5, 40], [6, 50], [4, 75]];
  return { from: d(-89), to: d(0), responses: r.length, promoters: prom, passives: r.length - prom - det, detractors: det,
    nps: npsOf(r.map((x) => x.score)), prev_nps: 38, avg_score: 8.2, completed_services: 13, answered_services: 10, pending_services: 2,
    distribution: Array.from({ length: 11 }, (_, i) => r.filter((x) => x.score === i).length),
    by_service: Object.entries(by).map(([service, xs]) => ({ service, responses: xs.length, nps: npsOf(xs), avg_score: Math.round(10 * xs.reduce((a, b) => a + b, 0) / xs.length) / 10 }))
      .sort((a, b) => b.responses - a.responses),
    by_month: months.map((m, i) => ({ month: m, responses: series[i][0], nps: series[i][1] })) };
}

const tenants = [
  { id: HQ, name: "YouCon Franqueadora", type: "franqueadora", status: "ativo", parent_tenant_id: null, slug: "youcon", city: "Poços de Caldas", state: "MG", created_at: "2026-01-10T12:00:00Z" },
  { id: POCOS, name: "YouCon Sul de Minas", type: "franquia", status: "ativo", parent_tenant_id: HQ, slug: "sul-de-minas", city: "Pouso Alegre", state: "MG", created_at: "2026-06-02T12:00:00Z" },
  { id: CAMPINAS, name: "YouCon Campinas", type: "franquia", status: "inativo", parent_tenant_id: HQ, slug: "campinas", city: "Campinas", state: "SP", created_at: "2026-08-15T12:00:00Z" },
];

let profiles: any[] = [
  ["p-ga", HQ, "Thiago Cardim", "thiago@youcon.com.br", "global_admin", null, null, "ativo", true],
  ["p-ua", HQ, "Mariana Lopes", "mariana@youcon.com.br", "unit_admin", "clt", null, "ativo", true],
  ["p-ld", HQ, "Rafael Andrade", "rafael@youcon.com.br", "leader", "clt", null, "ativo", true],
  ["p-cs", HQ, "Juliana Martins", "juliana.cs@youcon.com.br", "customer_success", "clt", null, "ativo", true],
  ["p-c1", HQ, "Beatriz Nogueira", "beatriz@youcon.com.br", "collaborator", "clt", null, "ativo", true],
  ["p-c2", HQ, "Lucas Ferreira", "lucas@youcon.com.br", "collaborator", "clt", null, "ativo", true],
  ["p-pj", HQ, "Camila Rocha", "camila.eng@gmail.com", "collaborator", "pj", null, "ativo", true],
  ["p-pj2", HQ, "Eduardo Prado", "eduardo.estrutural@gmail.com", "collaborator", "pj", null, "ativo", false],
  ["p-cl", HQ, "Fernanda Souza", "fernanda.souza@gmail.com", "client", null, "b2c", "ativo", true],
  ["p-cl2", HQ, "Construtora Horizonte", "obras@horizonte.com.br", "client", null, "b2b", "ativo", true],
  ["p-in", HQ, "Paulo Mendes", "paulo@youcon.com.br", "collaborator", "clt", null, "inativo", true],
  ["p-a2", HQ, "Isadora Lima", "isadora@youcon.com.br", "collaborator", "clt", null, "ativo", true],
  ["p-a3", HQ, "Leandro Matos", "leandro@youcon.com.br", "collaborator", "clt", null, "ativo", true],
  ["p-e2", HQ, "Gabriel Souto", "gabriel@youcon.com.br", "collaborator", "clt", null, "ativo", true],
  ["p-i1", HQ, "Carolina Dias", "carolina@youcon.com.br", "collaborator", "clt", null, "ativo", true],
  ["p-i2", HQ, "Larissa Gomes", "larissa.int@gmail.com", "collaborator", "pj", null, "ativo", true],
  ["p-fa", POCOS, "Juliana Prates", "juliana@youconsuldeminas.com.br", "unit_admin", null, null, "ativo", true],
  ["p-fl", POCOS, "André Vilela", "andre@youconsuldeminas.com.br", "leader", "pj", null, "ativo", true],
].map(([id, tenant_id, name, email, role, employment_type, client_type, status, linked], i) => ({
  id, auth_user_id: linked ? `auth-${id}` : null, tenant_id, name, email, role, employment_type, client_type, status,
  sector_id: ({ "p-ld": "s-arq", "p-c1": "s-arq", "p-a2": "s-arq", "p-a3": "s-arq", "p-c2": "s-eng",
    "p-pj": "s-eng", "p-e2": "s-eng", "p-i1": "s-int", "p-i2": "s-int" } as Record<string, string>)[id as string] ?? null,
  function_ids: ({ "p-ld": ["jf-arq"], "p-c1": ["jf-arq"], "p-pj": ["jf-est", "jf-ele"], "p-c2": ["jf-int"], "p-pj2": ["jf-est"] } as Record<string, string[]>)[id as string] ?? [],
  bio: ({ "p-ld": "Arquiteto e urbanista, coordena os projetos residenciais da YouCon há 8 anos.",
          "p-c1": "Arquiteta responsável pelo desenvolvimento do seu projeto, do estudo preliminar ao executivo.",
          "p-pj": "Engenheira civil especialista em estruturas e instalações elétricas residenciais.",
          "p-c2": "Designer de interiores focado em ambientes funcionais e acolhedores." } as Record<string, string>)[id as string] ?? null,
  phone: null, avatar_url: null, invited_at: `2026-0${(i % 8) + 1}-1${i % 9}T12:00:00Z`, last_seen_at: null, created_at: "2026-01-10T12:00:00Z",
}));

const clients = [
  { id: "c-1", tenant_id: HQ, name: "Fernanda Souza", client_type: "b2c", email: "fernanda.souza@gmail.com", status: "ativo" },
  { id: "c-2", tenant_id: HQ, name: "Construtora Horizonte", client_type: "b2b", email: "obras@horizonte.com.br", status: "ativo" },
];

const ROLE_PROFILE: Record<string, string> = {
  global_admin: "p-ga", unit_admin: "p-ua", leader: "p-ld", cs: "p-cs", clt: "p-c1", pj: "p-pj", client: "p-cl", empty: "p-ga",
};

function currentKey(): string | null {
  const as = new URLSearchParams(location.search).get("as");
  if (as) { try { sessionStorage.setItem("mock-as", as); } catch { /* */ } return as; }
  try { return sessionStorage.getItem("mock-as"); } catch { return null; }
}
const me = () => profiles.find((p) => p.id === ROLE_PROFILE[currentKey() ?? ""]) ?? null;

function permissions() {
  const p = me(); if (!p) return null;
  const r = p.role;
  const global = r === "global_admin";
  return {
    profile_id: p.id, tenant_id: p.tenant_id, role: r, employment_type: p.employment_type, client_type: p.client_type,
    can_manage_users: global || r === "unit_admin", can_manage_tenant: global || r === "unit_admin",
    can_manage_tenants: global, can_manage_templates: global, can_distribute: global,
    can_view_intake: global || r === "unit_admin", can_view_performance: (p.employment_type === "clt" && r !== "customer_success") || p.role === "global_admin",
    can_view_approvals: global || r === "unit_admin" || p.id === "p-ld", can_admin_approvals: global || r === "unit_admin",
    is_cs: r === "customer_success",
    is_manager: ["leader", "unit_admin", "global_admin"].includes(r), is_staff: r !== "client",
  };
}

const alert = (o: any) => ({
  responsible_user_id: null, planned_start_date: null, project_code: null, due_in_days: null, overdue_days: null, waiting_days: null,
  is_overdue: false, is_blocked: false, is_waiting_client: false, is_unassigned: false, ...o,
});

const ALERTS = [
  alert({ task_id: "t1", project_id: "pr1", task_name: "Estudo Preliminar", status: "in_progress", responsible_user_id: "p-c1", planned_end_date: d(-4), project_name: "Residência Souza", service_name: "Projeto Arquitetônico", due_in_days: -4, overdue_days: 4, is_overdue: true }),
  alert({ task_id: "t2", project_id: "pr2", task_name: "Projeto Legal", status: "in_progress", responsible_user_id: "p-c2", planned_end_date: d(-1), project_name: "Edifício Horizonte", service_name: "Aprovação / Projeto Legal", due_in_days: -1, overdue_days: 1, is_overdue: true }),
  alert({ task_id: "t3", project_id: "pr2", task_name: "Aprovação ou Alvará", status: "waiting_third_party", responsible_user_id: "p-c2", planned_end_date: d(12), project_name: "Edifício Horizonte", service_name: "Aprovação / Projeto Legal", due_in_days: 12, waiting_days: 6, is_blocked: true }),
  alert({ task_id: "t4", project_id: "pr3", task_name: "Envio do Briefing", status: "waiting_client", responsible_user_id: "p-c1", planned_end_date: d(2), project_name: "Clínica Vida", service_name: "Design de Interiores", due_in_days: 2, waiting_days: 5, is_waiting_client: true }),
  alert({ task_id: "t5", project_id: "pr1", task_name: "Briefing Arq + Apr + Eng", status: "ready", responsible_user_id: "p-pj", planned_end_date: d(0), project_name: "Residência Souza", service_name: "Projeto Elétrico", due_in_days: 0 }),
  alert({ task_id: "t6", project_id: "pr2", task_name: "Planejamento", status: "not_started", responsible_user_id: null, planned_end_date: d(9), project_name: "Edifício Horizonte", service_name: "Projeto Estrutural", due_in_days: 9, is_unassigned: true }),
  alert({ task_id: "t7", project_id: "pr3", task_name: "Renderização", status: "not_started", responsible_user_id: "p-c1", planned_end_date: d(1), project_name: "Clínica Vida", service_name: "Design de Interiores", due_in_days: 1 }),
];

function dashboard(): any {
  const p = me()!;
  const key = currentKey();
  const tenant = tenants.find((t) => t.id === p.tenant_id)!;
  const base = { me: { id: p.id, name: p.name, role: p.role, employment_type: p.employment_type, client_type: p.client_type, tenant: { id: tenant.id, name: tenant.name, type: tenant.type } }, generated_at: new Date().toISOString() };

  if (p.role === "client") {
    return { ...base, client: { projects: [{
      id: "pr1", code: "YC-2026-0014", name: "Residência Souza", status: "in_progress", city: "Poços de Caldas", state: "MG",
      contracted_at: d(-48), forecast_end: d(96), progress: 31, pending_from_client: 1,
      services: [
        { name: "Projeto Arquitetônico", track_status: "in_progress", progress: 40, current_step: { name: "Estudo Preliminar", status: "in_progress", planned_end_date: d(6) }, next_step: { name: "Alterações", planned_start_date: d(7) }, planned_end_date: d(68),
          steps: [
            { name: "Planejamento", status: "completed", planned_end_date: d(-30), actual_end_date: d(-31) },
            { name: "Envio do Briefing", status: "completed", planned_end_date: d(-20), actual_end_date: d(-19) },
            { name: "Estudo Preliminar", status: "in_progress", planned_end_date: d(6), actual_end_date: null },
            { name: "Alterações", status: "not_started", planned_end_date: d(48), actual_end_date: null },
            { name: "Imagens 3D e Vídeo", status: "not_started", planned_end_date: d(68), actual_end_date: null },
          ] },
        { name: "Design de Interiores", track_status: "in_progress", progress: 14, current_step: { name: "Envio do Briefing", status: "waiting_client", planned_end_date: d(2) }, next_step: { name: "Projeto de Interiores", planned_start_date: d(3) }, planned_end_date: d(96),
          steps: [
            { name: "Planejamento", status: "completed", planned_end_date: d(-6), actual_end_date: d(-6) },
            { name: "Envio do Briefing", status: "waiting_client", planned_end_date: d(2), actual_end_date: null },
            { name: "Projeto de Interiores", status: "not_started", planned_end_date: d(16), actual_end_date: null },
            { name: "Alteração", status: "not_started", planned_end_date: d(37), actual_end_date: null },
            { name: "Renderização", status: "not_started", planned_end_date: d(51), actual_end_date: null },
            { name: "Detalhamento", status: "not_started", planned_end_date: d(72), actual_end_date: null },
            { name: "Assessoria", status: "not_started", planned_end_date: d(79), actual_end_date: null },
          ] },
      ],
    }] } };
  }

  const mine = ALERTS.filter((a) => a.responsible_user_id === p.id);
  const out: any = { ...base, my_work: {
    counts: {
      open: mine.length, overdue: mine.filter((a) => a.is_overdue).length,
      due_today: mine.filter((a) => a.due_in_days === 0).length,
      due_next_7: mine.filter((a) => (a.due_in_days ?? 99) >= 1 && (a.due_in_days ?? 99) <= 7).length,
      waiting_client: mine.filter((a) => a.is_waiting_client).length, blocked: mine.filter((a) => a.is_blocked).length,
    },
    tasks: mine,
    projects: p.role === "collaborator" ? [
      { id: "pr1", code: "YC-2026-0014", name: "Residência Souza", status: "in_progress", project_role: p.employment_type === "pj" ? "Engenharia" : "Arquitetura" },
      ...(p.employment_type === "clt" ? [{ id: "pr3", code: "YC-2026-0019", name: "Clínica Vida", status: "in_progress", project_role: "Interiores" }] : []),
    ] : [],
  } };

  if (["leader", "unit_admin", "global_admin"].includes(p.role)) {
    const empty = key === "empty";
    out.operations = {
      counts: empty
        ? { projects_active: 0, awaiting_team: 0, awaiting_allocation: 0, tasks_overdue: 0, tasks_blocked: 0, tasks_waiting_client: 0, tasks_unassigned: 0, due_next_7: 0, projects_at_risk: 0, services_pending_review: 0 }
        : { projects_active: 6, awaiting_team: 2, awaiting_allocation: 0, tasks_overdue: 2, tasks_blocked: 1, tasks_waiting_client: 1, tasks_unassigned: 1, due_next_7: 4, projects_at_risk: 2, services_pending_review: 1 },
      awaiting_team: empty ? [] : [
        { id: "pr8", code: "YC-2026-0023", name: "Casa de campo", project_type: "Residencial", client_type: "b2c", client_name: "Ricardo e Helena Tavares", city: "Caldas", state: "MG", contracted_at: d(-2), services: ["Projeto Arquitetônico", "Projeto Estrutural", "Projeto Elétrico", "Projeto Hidrossanitário"] },
        { id: "pr9", code: "YC-2026-0024", name: "Galpão logístico", project_type: "Industrial", client_type: "b2b", client_name: "Construtora Horizonte", city: "Pouso Alegre", state: "MG", contracted_at: d(-1), services: ["Estudo de Viabilidade", "SPDA", "Combate a Incêndio"] },
      ],
      alerts: empty ? [] : ALERTS,
      team_load: empty ? [] : [
        { id: "p-c1", name: "Beatriz Nogueira", open: 7, overdue: 1 },
        { id: "p-c2", name: "Lucas Ferreira", open: 5, overdue: 1 },
        { id: "p-pj", name: "Camila Rocha", open: 3, overdue: 0 },
        { id: "p-ld", name: "Rafael Andrade", open: 1, overdue: 0 },
      ],
    };
    if (empty) out.my_work = { counts: { open: 0, overdue: 0, due_today: 0, due_next_7: 0, waiting_client: 0, blocked: 0 }, tasks: [], projects: [] };
  }
  if (["unit_admin", "global_admin"].includes(p.role)) {
    out.admin = {
      users: key === "empty" ? { active: 1, inactive: 0, clt: 0, pj: 0, clients: 0, pending_invite: 0 } : { active: 7, inactive: 1, clt: 4, pj: 2, clients: 2, pending_invite: 1 },
      intake: { received: key === "empty" ? 0 : 1, errors: 0, last_24h: key === "empty" ? 0 : 2 },
      tenants: p.role === "global_admin" ? overview() : null,
    };
  }
  return out;
}

function overview() {
  const p = me();
  return tenants
    .filter((t) => p?.role === "global_admin" || t.id === p?.tenant_id)
    .map((t) => {
      const ps = profiles.filter((x) => x.tenant_id === t.id);
      return {
        tenant_id: t.id, name: t.name, type: t.type, status: t.status, city: t.city, state: t.state,
        users_active: ps.filter((x) => x.status === "ativo" && x.role !== "client").length,
        users_inactive: ps.filter((x) => x.status === "inativo").length,
        collaborators_clt: ps.filter((x) => x.status === "ativo" && x.employment_type === "clt").length,
        collaborators_pj: ps.filter((x) => x.status === "ativo" && x.employment_type === "pj").length,
        clients: clients.filter((c) => c.tenant_id === t.id).length,
        projects_active: t.id === HQ ? 6 : t.id === POCOS ? 2 : 0,
        projects_awaiting: t.id === HQ ? 2 : 0,
        created_at: t.created_at,
      };
    });
}

const delay = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));

function rpc(name: string, _args?: any) {
  switch (name) {
    case "my_permissions": return delay({ data: permissions(), error: null });
    case "get_home_dashboard": return delay({ data: dashboard(), error: null }, 350);
    case "tenant_overview": return delay({ data: overview(), error: null });
    case "admin_create_tenant": return delay({ data: "new-id", error: null });
    case "preview_task_change": return delay({ data: {
      task: { id: _args?.p_task, name: "Estudo Preliminar", service: "Projeto Arquitetônico", before_start: d(-30), before_end: d(-2), after_start: d(-30), after_end: d(3),
        before_duration: 20, after_duration: 25 },
      impacted: [
        { id: "a", name: "Alterações", service: "Projeto Arquitetônico", same_service: true, before_start: d(-1), before_end: d(41), after_start: d(4), after_end: d(46) },
        { id: "b", name: "Imagens 3D e Vídeo", service: "Projeto Arquitetônico", same_service: true, before_start: d(42), before_end: d(55), after_start: d(47), after_end: d(60) },
        { id: "c", name: "Tempo de Produção da Arquitetura", service: "Projeto Estrutural", same_service: false, before_start: d(-40), before_end: d(-2), after_start: d(-40), after_end: d(3) },
        { id: "e", name: "Revisão APR x ARQ x ENG", service: "Projeto Estrutural", same_service: false, before_start: d(-1), before_end: d(0), after_start: d(4), after_end: d(5) },
        { id: "f", name: "Planejamento", service: "Projeto Estrutural", same_service: false, before_start: d(1), before_end: d(10), after_start: d(6), after_end: d(15) },
        { id: "g", name: "Planejamento", service: "Design de Interiores", same_service: false, before_start: d(12), before_end: d(30), after_start: d(17), after_end: d(35) },
        { id: "h", name: "Projeto de Interiores", service: "Design de Interiores", same_service: false, before_start: d(31), before_end: d(52), after_start: d(36), after_end: d(57) },
      ], impacted_count: 7, delay_days: 5, other_services_count: 2, forecast_before: d(55), forecast_after: d(60) }, error: null }, 300);
    case "reschedule_task": case "set_task_status": case "add_task_dependency": case "remove_task_dependency":
      return delay({ data: { impacted_count: 3, status: _args?.p_status }, error: null }, 300);
    case "set_task_responsible": case "set_profile_avatar": case "save_template_draft": case "publish_template": case "discard_template_draft":
      return delay({ data: null, error: null }, 300);
    case "reorder_task_library": return delay({ data: null, error: null }, 200);
    case "project_adjustments": return delay({ data: ADJUSTMENTS.filter((a) => !_args?.p_project || a.project_id === _args.p_project), error: null }, 150);
    case "my_pending_adjustments": return delay({ data: ADJUSTMENTS.filter((a) => a.can_decide), error: null }, 150);
    case "adjustment_create": return delay({ data: "adj-new", error: null }, 250);
    case "adjustment_decide": return delay({ data: { status: _args?.p_approve ? "approved" : "rejected", impacted_count: 6 }, error: null }, 300);
    case "add_task_note": NOTES.unshift({ id: `n${Date.now()}`, task_id: _args.p_task, body: _args.p_body, created_at: new Date().toISOString(), author: { name: me()?.name ?? "Você" } }); return delay({ data: "ok", error: null }, 200);
    case "adjustment_cancel": return delay({ data: null, error: null }, 200);
    case "preview_task_reopen": return delay({ data: {
      task: { id: _args?.p_task, name: "Envio do Briefing", service: "Projeto Arquitetônico", before_start: d(-44), before_end: d(-33), after_start: d(0), after_end: d(6),
        before_duration: 7, after_duration: _args?.p_days ?? 5 },
      impacted: [
        { id: "a", name: "Imagens 3D e Vídeo", service: "Projeto Arquitetônico", same_service: true, before_start: d(42), before_end: d(55), after_start: d(49), after_end: d(62) },
        { id: "f", name: "Planejamento", service: "Projeto Estrutural", same_service: false, before_start: d(1), before_end: d(10), after_start: d(8), after_end: d(17) },
        { id: "f2", name: "Produção da disciplina", service: "Projeto Estrutural", same_service: false, before_start: d(11), before_end: null, after_start: d(18), after_end: null },
        { id: "g", name: "Projeto de Interiores", service: "Design de Interiores", same_service: false, before_start: d(31), before_end: d(52), after_start: d(38), after_end: d(59) },
      ], impacted_count: 4, delay_days: _args?.p_days ?? 5, other_services_count: 2, forecast_before: d(55), forecast_after: d(62) }, error: null }, 300);
    case "reopen_task": return delay({ data: { impacted_count: 4 }, error: null }, 300);
    case "reschedule_task_with_reason": return delay({ data: { impacted_count: 3 }, error: null }, 300);
    case "client_schedule_changes": return delay({ data: [...CLIENT_CHANGES].sort((a, b) => b.changed_at.localeCompare(a.changed_at)), error: null }, 150);
    case "my_work_items": seedWorkItems(); return delay({ data: WORK_ITEMS.filter((w) => w.owner_id === me()?.id).map(workJson).sort((a, b) => a.due_date.localeCompare(b.due_date)), error: null }, 150);
    case "team_work_items": return delay({ data: teamWork(), error: null }, 200);
    case "assignable_people": return delay({ data: profiles.filter((t) => t.status !== "inativo" && canLead(me(), t)).map((t) => ({ id: t.id, name: t.name, avatar_url: t.avatar_url ?? null, role: t.role, employment_type: t.employment_type })), error: null }, 150);
    case "assign_work_items": {
      seedWorkItems();
      (_args.p_owners as string[]).forEach((o) => { const t = TASKS.find((x) => x.id === _args.p_task);
        WORK_ITEMS.push({ id: `wi${Date.now()}${o}`, owner_id: o, title: _args.p_title, description: _args.p_description, due_date: _args.p_due, done_at: null,
          project_task_id: _args.p_task, project_id: t?.project_id ?? _args.p_project, created_at: new Date().toISOString(), assigned_by: o === me()?.id ? null : me()?.id, assigned_at: o === me()?.id ? null : new Date().toISOString() }); });
      return delay({ data: (_args.p_owners as string[]).length, error: null }, 250);
    }
    case "performance_overview": return delay({ data: perfOverview(_args?.p_month), error: perfOverview(_args?.p_month) ? null : { message: "A performance não está disponível para o seu perfil", code: "42501" } }, 250);
    case "performance_person": return delay({ data: perfPerson(_args.p_profile, _args?.p_month), error: null }, 200);
    case "performance_highlights": return delay({ data: perfHighlights(_args?.p_month), error: null }, 150);
    case "set_person_sector": { const t = profiles.find((x) => x.id === _args.p_profile); if (t) t.sector_id = _args.p_sector; return delay({ data: null, error: null }, 150); }
    case "job_function_list": return delay({ data: JOB_FNS.filter((f) => f.tenant_id === _args.p_tenant).sort((a, b) => a.sort_order - b.sort_order)
      .map((f) => ({ ...f, people: profiles.filter((p) => (p.function_ids ?? []).includes(f.id)).length })), error: null }, 120);
    case "job_function_save": {
      if (_args.p_id) { const x = JOB_FNS.find((y) => y.id === _args.p_id); if (x) { x.profession = _args.p_profession; x.specialty = _args.p_specialty; } return delay({ data: _args.p_id, error: null }, 150); }
      const id = `jf-${Date.now()}`; JOB_FNS.push({ id, tenant_id: _args.p_tenant, profession: _args.p_profession, specialty: _args.p_specialty, sort_order: 999 }); return delay({ data: id, error: null }, 150);
    }
    case "job_function_delete": { const n = profiles.filter((p) => (p.function_ids ?? []).includes(_args.p_id)).length;
      profiles.forEach((p) => { p.function_ids = (p.function_ids ?? []).filter((x: string) => x !== _args.p_id); }); JOB_FNS = JOB_FNS.filter((x) => x.id !== _args.p_id); return delay({ data: n, error: null }, 150); }
    case "job_function_reorder": (_args.p_ids as string[]).forEach((id, i) => { const x = JOB_FNS.find((y) => y.id === id); if (x) x.sort_order = (i + 1) * 10; }); return delay({ data: null, error: null }, 120);
    case "set_person_profile": { const t = profiles.find((x) => x.id === _args.p_profile); if (t) { t.function_ids = _args.p_functions; t.bio = _args.p_bio; } return delay({ data: null, error: null }, 150); }
    case "project_client_waits": { const staff = me()?.role !== "client"; const ws = CWAITS.filter((w) => w.project_id === "pr1");
      return delay({ data: { days: CW_SETTINGS.days, enabled: CW_SETTINGS.enabled, total_late_days: ws.reduce((a, w) => a + w.late_days, 0), waits: ws.map((w) => cwFor(w, staff)) }, error: null }, 150); }
    case "my_client_waits": return delay({ data: me()?.role === "client" ? CWAITS.filter((w) => w.state !== "closed").map((w) => cwFor(w, false)) : [], error: null }, 150);
    case "client_waits_overview": return delay({ data: CWAITS.filter((w) => w.state !== "closed").map((w) => cwFor(w, true)), error: null }, 150);
    case "client_wait_return": { const w = CWAITS.find((x) => x.id === _args.p_wait); const back = w ? w.late_days : 0;
      if (w) Object.assign(w, { state: "closed", returned_on: _args.p_date, close_source: "team", returned_by: me()?.name, returned_note: _args.p_note, late_days: 0 });
      return delay({ data: { refunded_days: back }, error: null }, 250); }
    case "client_wait_waive": { const w = CWAITS.find((x) => x.id === _args.p_wait); const back = w ? w.late_days : 0;
      if (w) Object.assign(w, { waived_until: _args.p_until, waive_reason: _args.p_reason, late_days: 0 }); return delay({ data: { refunded_days: back }, error: null }, 250); }
    case "client_wait_settings_get": return delay({ data: { tenant_id: _args.p_tenant, ...CW_SETTINGS }, error: null }, 120);
    case "client_wait_settings_save": CW_SETTINGS = { enabled: _args.p_enabled, days: _args.p_days, documents_days: _args.p_documents_days ?? CW_SETTINGS.documents_days }; return delay({ data: null, error: null }, 200);
    case "project_client_access": return delay({ data: caccessBoard(), error: null }, 150);
    case "client_access_update": { const x = CACCESS.find((y) => y.id === _args.p_contact); if (x) Object.assign(x, { relation: _args.p_relation, scope: _args.p_all ? "all" : "projects", can_decide: _args.p_decide, projects: _args.p_all ? null : 1 }); return delay({ data: null, error: null }, 200); }
    case "client_access_remove": CACCESS = CACCESS.filter((y) => y.id !== _args.p_contact); return delay({ data: null, error: null }, 200);
    case "project_documents": return delay({ data: docBoard(), error: null }, 200);
    case "document_projects": return delay({ data: [{ id: "pr1", name: "Residência Souza", code: "YC-2026-0014", status: "in_progress", progress: docProgress() }], error: null }, 150);
    case "document_file_add": { if (String(_args.p_document).startsWith("dc-") && !DOCS.some((x) => x.id === _args.p_document)) DOCS.push({ id: _args.p_document, type: String(_args.p_document).slice(3), status: "pending", files: [] });
      const d = DOCS.find((x) => x.id === _args.p_document); if (d) { d.files.push(docFile(`f${Date.now()}`, _args.p_name ?? "Link", _args.p_kind)); if (d.status !== "submitted") { d.status = "submitted"; d.submitted_at = new Date().toISOString(); } } return delay({ data: "f", error: null }, 250); }
    case "document_file_remove": { DOCS.forEach((d) => { d.files = d.files.filter((f: any) => f.id !== _args.p_file); if (d.status === "submitted" && !d.files.length) d.status = "pending"; }); return delay({ data: null, error: null }, 150); }
    case "document_review": { const d = DOCS.find((x) => x.id === _args.p_document); if (d) { if (_args.p_approve) Object.assign(d, { status: "approved", reviewed_by: me()?.name, reviewed_at: new Date().toISOString() });
      else Object.assign(d, { status: "rejected", round: (d.round ?? 1) + 1, history: [...(d.history ?? []), ...d.files], files: [], reject_reason: _args.p_reason }); } return delay({ data: null, error: null }, 200); }
    case "document_extra_add": { const id = `dx${Date.now()}`; DOCS.push({ id, source: "extra", name: _args.p_name, description: _args.p_description, required: _args.p_required, status: "pending", files: [], requested_by: me()?.name }); return delay({ data: id, error: null }, 200); }
    case "document_extra_update": { const d = DOCS.find((x) => x.id === _args.p_document); if (d) Object.assign(d, { name: _args.p_name, description: _args.p_description, required: _args.p_required }); return delay({ data: null, error: null }, 150); }
    case "document_remove": { const d = DOCS.find((x) => x.id === _args.p_document); if (d) { DOCS = DOCS.filter((x) => x !== d); DOCS_REMOVED.unshift({ ...d, removed_reason: _args.p_reason }); } return delay({ data: null, error: null }, 150); }
    case "document_restore": { const d = DOCS_REMOVED.find((x) => x.id === _args.p_document); if (d) { DOCS_REMOVED = DOCS_REMOVED.filter((x) => x !== d); DOCS.push({ ...d, removed_reason: undefined }); } return delay({ data: null, error: null }, 150); }
    case "document_answer": DOC_ANSWER = _args.p_answer; return delay({ data: null, error: null }, 200);
    case "documents_wait_set": DOCS_WAIT = _args.p_on; return delay({ data: null, error: null }, 200);
    case "document_section_save": { if (_args.p_id) { const x = DOC_SECTIONS.find((y) => y.id === _args.p_id); if (x) x.name = _args.p_name; return delay({ data: _args.p_id, error: null }, 150); }
      const id = `ds${Date.now()}`; DOC_SECTIONS.push({ id, name: _args.p_name, sort_order: 999 }); return delay({ data: id, error: null }, 150); }
    case "document_section_delete": DOC_SECTIONS = DOC_SECTIONS.filter((x) => x.id !== _args.p_id); return delay({ data: null, error: null }, 150);
    case "document_sections_reorder": DOC_SECTIONS = (_args.p_ids as string[]).map((id, i) => ({ ...DOC_SECTIONS.find((x) => x.id === id), sort_order: (i + 1) * 10 })); return delay({ data: null, error: null }, 120);
    case "document_question_save": { if (_args.p_id) { const x = DOC_QUESTIONS.find((y) => y.id === _args.p_id); if (x) Object.assign(x, { text: _args.p_text, help: _args.p_help }); return delay({ data: _args.p_id, error: null }, 150); }
      const id = `dq${Date.now()}`; DOC_QUESTIONS.push({ id, text: _args.p_text, help: _args.p_help }); return delay({ data: id, error: null }, 150); }
    case "document_question_delete": DOC_QUESTIONS = DOC_QUESTIONS.filter((x) => x.id !== _args.p_id); return delay({ data: null, error: null }, 150);
    case "document_types_list": return delay({ data: { can_edit: me()?.role === "global_admin", types: DOC_TYPES, sections: DOC_SECTIONS, questions: DOC_QUESTIONS,
      services: CATALOG_SERVICES_FOR_DOCS() }, error: null }, 150);
    case "document_type_save": { if (_args.p_id) { const t = DOC_TYPES.find((x) => x.id === _args.p_id); if (t) Object.assign(t, { name: _args.p_name, description: _args.p_description, required: _args.p_required, service_codes: _args.p_service_codes?.length ? _args.p_service_codes : null, section_id: _args.p_section, holder: _args.p_holder, question_id: _args.p_question }); return delay({ data: _args.p_id, error: null }, 200); }
      const id = `dt${Date.now()}`; DOC_TYPES.push({ id, name: _args.p_name, description: _args.p_description, required: _args.p_required, service_codes: _args.p_service_codes?.length ? _args.p_service_codes : null, section_id: _args.p_section, holder: _args.p_holder, question_id: _args.p_question, sort_order: 999 }); return delay({ data: id, error: null }, 200); }
    case "document_type_delete": DOC_TYPES = DOC_TYPES.filter((x) => x.id !== _args.p_id); return delay({ data: null, error: null }, 150);
    case "document_types_reorder": DOC_TYPES = (_args.p_ids as string[]).map((id) => DOC_TYPES.find((x) => x.id === id)).filter(Boolean); return delay({ data: null, error: null }, 120);
    case "project_deliveries": return delay({ data: dlvBoard(_args.p_project), error: null }, 200);
    case "delivery_projects": return delay({ data: [{ id: "pr1", name: "Residência Souza", code: "YC-2026-0014", awaiting_client: Object.keys(DLV).filter((k) => dlvCalc(DLV[k]).status === "awaiting_client").length, published: 12, last_published_at: dAgo(2) }], error: null }, 150);
    case "delivery_version_start": case "delivery_version_update": case "delivery_file_add": case "delivery_file_remove": case "delivery_version_discard":
    case "delivery_version_publish": case "delivery_request_revision": case "delivery_approve": case "delivery_extra_request": case "delivery_extra_decide":
      return delay({ data: dlvAct(name, _args), error: null }, 250);
    case "delivery_settings_list": return delay({ data: { can_edit: me()?.role === "global_admin", services: DLV_SETTINGS }, error: null }, 150);
    case "delivery_settings_save": { const x = DLV_SETTINGS.find((y) => y.id === _args.p_service); if (x) Object.assign(x, { revisions_enabled: _args.p_enabled, included_revisions: _args.p_included, creation_task_codes: _args.p_codes }); return delay({ data: null, error: null }, 200); }
    case "revisions_overview": { const pr = me(); const manager = ["leader", "unit_admin", "global_admin"].includes(pr?.role);
      return delay({ data: { month: _args.p_month, month_end: _args.p_month, scope: manager ? "team" : "self", people: manager ? REV_PEOPLE : REV_PEOPLE.filter((x) => x.id === pr?.id) }, error: null }, 200); }
    case "revisions_person": return delay({ data: _args.p_profile === "p-c2" || _args.p_profile === "p-c1" ? [
      { id: "rv1", round: 4, created_at: dAgo(3), items: 1, on_behalf: false, project_id: "pr1", project_name: "Residência Souza", project_code: "YC-2026-0014", service: "Design de Interiores", allowed: 4, approved: true },
      { id: "rv2", round: 3, created_at: dAgo(8), items: 2, on_behalf: true, project_id: "pr1", project_name: "Residência Souza", project_code: "YC-2026-0014", service: "Design de Interiores", allowed: 4, approved: true },
      { id: "rv3", round: 1, created_at: dAgo(9), items: 3, on_behalf: false, project_id: "pr1", project_name: "Residência Souza", project_code: "YC-2026-0014", service: "Projeto Arquitetônico", allowed: 3, approved: false },
    ] : [], error: null }, 150);
    case "support_options": return delay({ data: { categories: SUPPORT_CATS.filter((c) => c.active), projects: [{ id: "pr1", name: "Residência Souza", code: "YC-2026-0014" }, { id: "pr7", name: "Reforma do apartamento", code: "YC-2026-0019" }] }, error: null }, 150);
    case "support_open": return delay({ data: supportOpen(_args), error: null }, 300);
    case "support_tickets_list": return delay({ data: SUPPORT_TICKETS, error: null }, 200);
    case "support_ticket_update": { const t = SUPPORT_TICKETS.find((x) => x.id === _args.p_id); if (t) { t.status = _args.p_status; t.cs_note = _args.p_note ?? t.cs_note; t.closed_at = _args.p_status === "open" ? null : new Date().toISOString(); t.closed_by = _args.p_status === "open" ? null : { id: "p-cs", name: "Juliana Martins" }; } return delay({ data: null, error: null }, 200); }
    case "support_settings_get": return delay({ data: { tenant_id: _args.p_tenant, ...SUPPORT_SETTINGS, default_template: SUPPORT_TPL, people: SUPPORT_PEOPLE, categories: SUPPORT_CATS, can_edit_categories: me()?.role === "global_admin" }, error: null }, 150);
    case "support_settings_save": SUPPORT_SETTINGS = { cs_whatsapp: _args.p_cs_whatsapp?.replace(/\D/g, "") || null, message_template: _args.p_template || SUPPORT_TPL }; return delay({ data: null, error: null }, 200);
    case "set_person_whatsapp": { const p = SUPPORT_PEOPLE.find((x) => x.id === _args.p_profile); let d = (_args.p_whatsapp ?? "").replace(/\D/g, ""); if (d.length === 10 || d.length === 11) d = "55" + d; if (p) p.whatsapp = d || null; return delay({ data: d || null, error: null }, 200); }
    case "support_category_save": { if (_args.p_id) { const c = SUPPORT_CATS.find((x) => x.id === _args.p_id); Object.assign(c, { label: _args.p_label, description: _args.p_description, target: _args.p_target, active: _args.p_active }); } else SUPPORT_CATS.push({ id: "sc" + Date.now(), label: _args.p_label, description: _args.p_description, target: _args.p_target, sort_order: 99, active: true }); return delay({ data: "ok", error: null }, 200); }
    case "nps_pending": return delay({ data: me()?.role === "client" ? NPS_PENDING : [], error: null }, 150);
    case "nps_answer": case "nps_skip": NPS_PENDING = NPS_PENDING.filter((x) => x.project_service_id !== _args.p_ps); return delay({ data: null, error: null }, 250);
    case "nps_overview": return delay({ data: npsOverview(), error: null }, 220);
    case "nps_responses_list": return delay({ data: NPS_ROWS, error: null }, 220);
    case "cs_requests_list": {
      const p = me(); let list = CS_REQ.map(csJson);
      if (_args.p_project) list = list.filter((r) => r.project_id === _args.p_project);
      if (_args.p_scope === "mine") list = list.filter((r) => r.is_recipient || r.created_by.id === p?.id);
      return delay({ data: list.sort((a, b) => Number(["open", "answered"].includes(b.status)) - Number(["open", "answered"].includes(a.status)) || a.due_at.localeCompare(b.due_at)), error: null }, 200);
    }
    case "cs_request_detail": { const r = CS_REQ.find((x) => x.id === _args.p_id); return delay({ data: r ? { ...csJson(r), thread: r.thread } : null, error: r ? null : { message: "Chamado não encontrado" } }, 200); }
    case "cs_request_create": {
      const id = `cs-${Date.now()}`;
      const sched = (_args.p_urgency === "urgent" ? 4 : _args.p_urgency === "high" ? 26 : 50);
      CS_REQ.unshift({ id, project_id: _args.p_project, kind: _args.p_kind, urgency: _args.p_urgency, title: _args.p_title, body: _args.p_body, task: null,
        status: "open", due_at: hIn(sched), created_at: new Date().toISOString(), first_response_at: null, thread: [] });
      if (!CS_PNAME[_args.p_project]) CS_PNAME[_args.p_project] = [PROJECTS.find((x) => x.id === _args.p_project)?.name ?? "Projeto", null as any, null as any];
      return delay({ data: id, error: null }, 300);
    }
    case "cs_request_reply": {
      const r = CS_REQ.find((x) => x.id === _args.p_id); const p = me();
      if (r) { r.thread.push({ id: `m-${Date.now()}`, body: _args.p_body, created_at: new Date().toISOString(), author: { id: p.id, name: p.name, avatar_url: null, role: p.role } });
        if (p.role === "customer_success") r.status = "open"; else { r.status = r.status === "open" ? "answered" : r.status; r.first_response_at ??= new Date().toISOString(); } }
      return delay({ data: null, error: null }, 250);
    }
    case "cs_request_set_status": { const r = CS_REQ.find((x) => x.id === _args.p_id); if (r) { r.status = _args.p_status === "open" ? (r.first_response_at ? "answered" : "open") : _args.p_status; r.resolved_at = _args.p_status === "open" ? null : new Date().toISOString(); } return delay({ data: null, error: null }, 200); }
    case "cs_dashboard": return delay({ data: csDashboard(), error: null }, 250);
    case "cs_settings_get": return delay({ data: { tenant_id: _args.p_tenant, normal_days: 2, high_days: 1, urgent_hours: 4 }, error: null }, 120);
    case "cs_settings_save": return delay({ data: null, error: null }, 200);
    case "project_approval_board": return delay({ data: aprBoard(_args.p_project), error: null }, 200);
    case "approvals_list": return delay({ data: APPROVALS.filter((a) => a.status !== "cancelled").map(aprFlags)
      .sort((a, b) => b.approved_on.localeCompare(a.approved_on)), error: null }, 220);
    case "approval_rates_list": return delay({ data: APR_TYPES.map((t) => ({ type_id: t.id, code: t.code, name: t.name, active: true, amount: APR_RATES[t.code] ?? null, updated_at: null })), error: null }, 150);
    case "approval_rate_save": { const t = APR_TYPES.find((x) => x.id === _args.p_type); if (t) APR_RATES[t.code] = _args.p_amount; return delay({ data: null, error: null }, 150); }
    case "approval_review": { const a = APPROVALS.find((x) => x.id === _args.p_id); if (a) { a.status = _args.p_ok ? "to_release" : "proof_rejected"; a.review_note = _args.p_note; a.reviewed_at = new Date().toISOString(); a.reviewed_by = { id: "p-ld", name: "Rafael Andrade" }; } return delay({ data: null, error: null }, 200); }
    case "approval_set_status": { const a = APPROVALS.find((x) => x.id === _args.p_id); if (a) { a.status = _args.p_status; if (_args.p_status === "released") a.released_at = new Date().toISOString(); if (_args.p_status === "paid") a.paid_at = new Date().toISOString(); } return delay({ data: null, error: null }, 200); }
    case "approval_update": { const a = APPROVALS.find((x) => x.id === _args.p_id); if (a) { a.amount = _args.p_amount; const r = profiles.find((x) => x.id === _args.p_recipient); if (r) a.recipient = aprPerson(r.id, r.name); } return delay({ data: null, error: null }, 200); }
    case "approval_include_tramite": { const code = String(_args.p_service).replace("svc-", ""); (APR_INCLUDED[_args.p_project] ??= []).push(code); (APR_PROJ[_args.p_project] ??= ["prefeitura", "condominio"]).push(code); return delay({ data: { tracks_created: 1 }, error: null }, 300); }
    case "approval_register": {
      const ty = APR_TYPES.find((t) => t.id === _args.p_type)!; const ex = APPROVALS.find((x) => x.id === _args.p_id);
      if (ex) { Object.assign(ex, { status: "awaiting_review", proof: _args.p_proof, approved_on: _args.p_approved_on }); return delay({ data: ex.id, error: null }, 300); }
      const [project_name, project_code, client_name] = APR_PNAME[_args.p_project] ?? ["Projeto", null, null]; const mine = me();
      APPROVALS.unshift({ id: _args.p_id, project_id: _args.p_project, tenant_id: HQ, tenant_name: "YouCon Franqueadora", project_name, project_code, client_name,
        type_id: ty.id, type_name: ty.name, type_code: ty.code, protocol_number: _args.p_protocol, approved_on: _args.p_approved_on, notes: null, proof: _args.p_proof,
        status: "awaiting_review", review_note: null, cancel_note: null, registered_at: new Date().toISOString(), registered_by: { id: mine.id, name: mine.name },
        reviewed_at: null, reviewed_by: null, released_at: null, paid_at: null, recipient: aprPerson(mine.id, mine.name), amount: APR_RATES[ty.code] ?? null });
      return delay({ data: _args.p_id, error: null }, 300);
    }
    case "faq_feedback_add": FAQ_FB.unshift({ id: `fb-${Date.now()}`, item_id: _args.p_item, helpful: _args.p_helpful, query: _args.p_query, created_at: new Date().toISOString() }); return delay({ data: null, error: null }, 150);
    case "faq_item_save": {
      const x = _args.p_id ? FAQ_ITEMS.find((y) => y.id === _args.p_id) : null;
      if (x) Object.assign(x, { category_id: _args.p_category, question: _args.p_question, answer: _args.p_answer, keywords: _args.p_keywords, archived_at: null });
      else FAQ_ITEMS.push({ id: `fi-new-${Date.now()}`, category_id: _args.p_category, question: _args.p_question, answer: _args.p_answer, keywords: _args.p_keywords, sort_order: 99999, archived_at: null, updated_at: new Date().toISOString() });
      return delay({ data: x?.id ?? FAQ_ITEMS[FAQ_ITEMS.length - 1].id, error: null }, 150);
    }
    case "faq_item_archive": { const x = FAQ_ITEMS.find((y) => y.id === _args.p_id); if (x) x.archived_at = new Date().toISOString(); return delay({ data: null, error: null }, 150); }
    case "faq_category_save": {
      const x = _args.p_id ? FAQ_CATS.find((y) => y.id === _args.p_id) : null;
      if (x) { x.title = _args.p_title; return delay({ data: x.id, error: null }, 150); }
      const id = `fc-new-${Date.now()}`; FAQ_CATS.push({ id, title: _args.p_title, sort_order: 9999, archived_at: null }); return delay({ data: id, error: null }, 150);
    }
    case "faq_category_archive": {
      if (FAQ_ITEMS.some((y) => y.category_id === _args.p_id && !y.archived_at)) return delay({ data: null, error: { message: "Mova ou exclua as perguntas desta categoria antes de excluí-la", code: "23514" } }, 150);
      const x = FAQ_CATS.find((y) => y.id === _args.p_id); if (x) x.archived_at = new Date().toISOString(); return delay({ data: null, error: null }, 150);
    }
    case "client_project_team": return delay({ data: clientTeam(_args.p_project), error: null }, 200);
    case "sector_list": return delay({ data: sectorList(_args.p_tenant), error: null }, 120);
    case "sector_save": {
      if (_args.p_id) { const x = SECTORS.find((y) => y.id === _args.p_id); if (x) x.name = _args.p_name; return delay({ data: _args.p_id, error: null }, 150); }
      const id = `s-${Date.now()}`; SECTORS.push({ id, tenant_id: _args.p_tenant, name: _args.p_name, sort_order: 999 }); return delay({ data: id, error: null }, 150);
    }
    case "sector_delete": { const n = profiles.filter((p) => p.sector_id === _args.p_id).length; profiles.forEach((p) => { if (p.sector_id === _args.p_id) p.sector_id = null; });
      SECTORS = SECTORS.filter((x) => x.id !== _args.p_id); return delay({ data: n, error: null }, 150); }
    case "sector_reorder": (_args.p_ids as string[]).forEach((id, i) => { const x = SECTORS.find((y) => y.id === id); if (x) x.sort_order = (i + 1) * 10; }); return delay({ data: null, error: null }, 120);
    case "save_performance_settings": PERF_SET = { ...PERF_SET, ..._args.p }; return delay({ data: PERF_SET, error: null }, 200);
    case "my_steps": return delay({ data: mySteps(), error: null }, 200);
    case "my_notifications": return delay({ data: NOTIFS, error: null }, 100);
    case "automation_save": {
      const pl = _args.p_payload;
      if (_args.p_id) Object.assign(AUTOMATIONS.find((a) => a.id === _args.p_id), pl);
      else AUTOMATIONS.push({ id: `au${Date.now()}`, run_count: 0, last_run_at: null, archived: false, created_at: new Date().toISOString(), updated_at: "", ...pl });
      return delay({ data: "ok", error: null }, 300);
    }
    case "automation_set_active": { AUTOMATIONS.find((a) => a.id === _args.p_id).active = _args.p_active; return delay({ data: null, error: null }, 150); }
    case "automation_archive": { AUTOMATIONS.find((a) => a.id === _args.p_id).archived = true; return delay({ data: null, error: null }, 150); }
    case "board_ensure": {
      if (!BOARD_COLS.length) {
        BOARD_COLS.push({ id: "bc1", name: "A iniciar", sort_order: 10, active: true }, { id: "bc2", name: "Em andamento", sort_order: 20, active: true },
          { id: "bc3", name: "Revisão com cliente", sort_order: 30, active: true }, { id: "bc4", name: "Encerrados", sort_order: 40, active: true });
        PROJECTS.forEach((x: any, i: number) => BOARD_CARDS.push({ project_id: x.id, sort_order: (i + 1) * 10,
          column_id: x.status.startsWith("awaiting") ? "bc1" : ["completed", "cancelled"].includes(x.status) ? "bc4" : i % 2 ? "bc3" : "bc2" }));
      }
      return delay({ data: null, error: null }, 100);
    }
    case "board_add_column": { const id = `bc${Date.now()}`; BOARD_COLS.push({ id, name: _args.p_name, sort_order: 999, active: true }); return delay({ data: id, error: null }, 200); }
    case "board_rename_column": { const c = BOARD_COLS.find((x) => x.id === _args.p_column); if (c) c.name = _args.p_name; return delay({ data: null, error: null }, 200); }
    case "board_reorder_columns": { (_args.p_ids as string[]).forEach((id, i) => { const c = BOARD_COLS.find((x) => x.id === id); if (c) c.sort_order = (i + 1) * 10; }); return delay({ data: null, error: null }, 150); }
    case "board_delete_column": {
      const c = BOARD_COLS.find((x) => x.id === _args.p_column)!;
      if (c.name.toLowerCase() !== String(_args.p_confirm).trim().toLowerCase()) return delay({ data: null, error: { message: `Para excluir, digite exatamente o nome da coluna: ${c.name}` } });
      let moved = 0; BOARD_CARDS.forEach((k) => { if (k.column_id === c.id) { k.column_id = _args.p_move_to; moved++; } }); c.active = false;
      return delay({ data: { moved }, error: null }, 300);
    }
    case "board_move_card": {
      const k = BOARD_CARDS.find((x) => x.project_id === _args.p_project);
      if (k) { k.column_id = _args.p_column; k.sort_order = 9999; } else BOARD_CARDS.push({ project_id: _args.p_project, column_id: _args.p_column, sort_order: 9999 });
      return delay({ data: null, error: null }, 150);
    }
    case "project_step_options": {
      const pr = PROJECTS.find((x) => x.id === _args?.p_project);
      const rows = (pr?.services ?? []).flatMap((x: any, si: number) => {
        const tpl = TEMPLATES.find((t) => t.service_id === x.service.id && t.active);
        return (tpl?.tasks ?? []).map((t: any) => ({ project_service_id: x.id, service_name: x.service.name, service_sort: si, task_code: t.code, task_name: t.name,
          task_sort: t.sort_order, user_id: pr.id === "pr1" && x.service.id === "arq" && t.code === "imagens_3d_video" ? "p-pj2" : null, from_schedule: pr.status === "in_progress" }));
      });
      return delay({ data: rows, error: null });
    }
    case "set_step_assignments": return delay({ data: { added: 1, removed: 0, tasks_updated: 1 }, error: null }, 300);
    case "template_usage": return delay({ data: TEMPLATES.filter((t) => t.service_id === _args?.p_service).map((t) => ({ template_id: t.id, projects_in_progress: t.active ? 3 : 0 })), error: null });
    case "delete_template_variant": return delay({ data: { archived: 1, projects_in_progress: 3 }, error: null }, 300);
    case "add_project_task": return delay({ data: { task_id: "tr-arq-alteracoes", impacted_count: 2 }, error: null }, 300);
    case "create_template_draft": return delay({ data: "t-arq2", error: null }, 300);
    case "generate_project_schedule": case "set_project_area": case "activate_project_service":
      return delay({ data: { tracks_created: 1, tasks_created: 7, tracks_pending: 0 }, error: null }, 300);
    case "assign_project_team": return delay({ data: { started: true, added: 2, removed: 0 }, error: null }, 400);
    case "allocate_project": case "ignore_intake": return delay({ data: null, error: null }, 400);
    case "reprocess_intake": case "create_manual_intake":
      return delay({ data: { status: "error", errors: ["Serviço não reconhecido: Ar condicionado"] }, error: null }, 400);
    default: return delay({ data: null, error: { message: `rpc ${name} não simulada` } });
  }
}

// ---------- Etapa 2 ----------
const svc = (id: string, name: string, family: string, role: string, status = "active", contracted = d(-2)) =>
  ({ id: `ps-${id}`, status, active: true, contracted_at: contracted, contract_source: "pipefy",
     service: { id, name, code: id, leadership_area: family === "Engenharia" ? "engineering" : family.startsWith("Aprova") ? "approval" : "architecture",
       family: { name: family, default_project_role: role } } });

const RESP: Record<string, [string, string, string]> = { arq: ["p-c1", "Beatriz Nogueira", "clt"], est: ["p-pj", "Camila Rocha", "pj"], int: ["p-c2", "Lucas Ferreira", "clt"] };
const PROJECTS: any[] = [
  { id: "pr8", code: "YC-2026-0023", name: "Casa de campo", status: "awaiting_team_assignment", client_type: "b2c", project_type: "Residencial",
    city: "Caldas", state: "MG", address: "Estrada da Serra, km 4", area_m2: 286.5, contracted_at: d(-2), created_at: d(-2) + "T14:10:00Z", started_at: null,
    external_source: "pipefy", external_id: "1029384756", origin_tenant_id: HQ, commercial_tenant_id: HQ, delivery_tenant_id: HQ,
    client: { id: "c-3", tenant_id: HQ, name: "Ricardo e Helena Tavares", client_type: "b2c", email: "ricardo.tavares@gmail.com", phone: "(35) 99812-4410", document: null, company_name: null, status: "ativo" },
    origin: { name: "YouCon Franqueadora" }, commercial: { name: "YouCon Franqueadora" }, delivery: { name: "YouCon Franqueadora" },
    services: [svc("arq", "Projeto Arquitetônico", "Arquitetura", "architecture"), svc("est", "Projeto Estrutural", "Engenharia", "engineering"),
               svc("ele", "Projeto Elétrico", "Engenharia", "engineering"), svc("hid", "Projeto Hidrossanitário", "Engenharia", "engineering")],
    team: [], allocations: [{ id: "al1", allocation_method: "automatic_headquarters", allocation_status: "confirmed", allocated_at: d(-2) + "T14:10:00Z", notes: null, created_at: d(-2) + "T14:10:00Z", delivery: { name: "YouCon Franqueadora" } }] },
  { id: "pr9", code: "YC-2026-0024", name: "Galpão logístico", status: "awaiting_allocation", client_type: "b2b", project_type: "Industrial",
    city: "Pouso Alegre", state: "MG", address: null, area_m2: 4200, contracted_at: d(-1), created_at: d(-1) + "T10:00:00Z", started_at: null,
    external_source: "pipefy", external_id: "1029384999", origin_tenant_id: HQ, commercial_tenant_id: HQ, delivery_tenant_id: null,
    client: { id: "c-2", tenant_id: HQ, name: "Construtora Horizonte", client_type: "b2b", email: "obras@horizonte.com.br", phone: null, document: "12345678000190", company_name: "Horizonte Engenharia Ltda.", status: "ativo" },
    origin: { name: "YouCon Franqueadora" }, commercial: { name: "YouCon Franqueadora" }, delivery: null,
    services: [svc("via", "Estudo de Viabilidade", "Arquitetura", "architecture"), svc("spda", "SPDA", "Engenharia", "engineering"), svc("inc", "Combate a Incêndio", "Engenharia", "engineering")],
    team: [], allocations: [{ id: "al2", allocation_method: "manual", allocation_status: "pending", allocated_at: null, notes: null, created_at: d(-1) + "T10:00:00Z", delivery: null }] },
  { id: "pr1", code: "YC-2026-0014", name: "Residência Souza", status: "in_progress", client_type: "b2c", project_type: "Residencial",
    city: "Poços de Caldas", state: "MG", address: null, area_m2: 210, contracted_at: d(-48), created_at: d(-48) + "T10:00:00Z", started_at: d(-46),
    external_source: "pipefy", external_id: "998877", origin_tenant_id: HQ, commercial_tenant_id: HQ, delivery_tenant_id: HQ,
    client: { id: "c-1", tenant_id: HQ, name: "Fernanda Souza", client_type: "b2c", email: "fernanda.souza@gmail.com", phone: null, document: null, company_name: null, status: "ativo" },
    origin: { name: "YouCon Franqueadora" }, commercial: { name: "YouCon Franqueadora" }, delivery: { name: "YouCon Franqueadora" },
    services: [svc("arq", "Projeto Arquitetônico", "Arquitetura", "architecture", "active", d(-48)), svc("est", "Projeto Estrutural", "Engenharia", "engineering", "active", d(-48)),
               svc("int", "Design de Interiores", "Interiores", "interiors", "active", d(-48)),
               svc("ele", "Projeto Elétrico", "Engenharia", "engineering", "pending_review", d(-3))],
    team: [
      { id: "tm1", project_role: "lead_architecture", employment_type: "clt", active: true, assigned_at: d(-46), user: { id: "p-ld", name: "Rafael Andrade", avatar_url: null, employment_type: "clt" } },
      { id: "tm1b", project_role: "lead_engineering", employment_type: "pj", active: true, assigned_at: d(-46), user: { id: "p-pj", name: "Camila Rocha", avatar_url: null, employment_type: "pj" } },
      { id: "tm1c", project_role: "lead_approval", employment_type: "clt", active: true, assigned_at: d(-46), user: { id: "p-ld", name: "Rafael Andrade", avatar_url: null, employment_type: "clt" } },
      { id: "tm2", project_role: "architecture", employment_type: "clt", active: true, assigned_at: d(-46), user: { id: "p-c1", name: "Beatriz Nogueira", avatar_url: null, employment_type: "clt" } },
      { id: "tm3", project_role: "engineering", employment_type: "pj", active: true, assigned_at: d(-3), user: { id: "p-pj", name: "Camila Rocha", avatar_url: null, employment_type: "pj" } },
      { id: "tm5", project_role: "interiors", employment_type: "clt", active: true, assigned_at: d(-3), user: { id: "p-c2", name: "Lucas Ferreira", avatar_url: null, employment_type: "clt" } },
      { id: "tm6", project_role: "support", employment_type: "pj", active: true, assigned_at: d(-3), user: { id: "p-pj2", name: "Eduardo Prado", avatar_url: null, employment_type: "pj" } },
    ],
    allocations: [{ id: "al3", allocation_method: "automatic_headquarters", allocation_status: "confirmed", allocated_at: d(-48) + "T10:00:00Z", notes: null, created_at: d(-48) + "T10:00:00Z", delivery: { name: "YouCon Franqueadora" } }] },
  { id: "pr3", code: "YC-2026-0019", name: "Clínica Vida", status: "in_progress", client_type: "b2b", project_type: "Comercial",
    city: "Poços de Caldas", state: "MG", address: null, area_m2: 140, contracted_at: d(-20), created_at: d(-20) + "T10:00:00Z", started_at: d(-19),
    external_source: "manual", external_id: null, origin_tenant_id: HQ, commercial_tenant_id: HQ, delivery_tenant_id: HQ,
    client: { id: "c-4", tenant_id: HQ, name: "Clínica Vida", client_type: "b2b", email: "contato@clinicavida.com.br", phone: null, document: null, company_name: null, status: "ativo" },
    origin: { name: "YouCon Franqueadora" }, commercial: { name: "YouCon Franqueadora" }, delivery: { name: "YouCon Franqueadora" },
    services: [svc("int", "Design de Interiores", "Interiores", "interiors", "active", d(-20))],
    team: [{ id: "tm4", project_role: "lead_architecture", employment_type: "clt", active: true, assigned_at: d(-19), user: { id: "p-c1", name: "Beatriz Nogueira", avatar_url: null, employment_type: "clt" } }],
    allocations: [] },
  { id: "pr4", code: "YC-2026-0007", name: "Apartamento 1201", status: "completed", client_type: "b2c", project_type: "Residencial",
    city: "Pouso Alegre", state: "MG", address: null, area_m2: 98, contracted_at: d(-160), created_at: d(-160) + "T10:00:00Z", started_at: d(-158),
    external_source: "pipefy", external_id: "555", origin_tenant_id: POCOS, commercial_tenant_id: POCOS, delivery_tenant_id: POCOS,
    client: { id: "c-5", tenant_id: POCOS, name: "Marcos Ribeiro", client_type: "b2c", email: null, phone: null, document: null, company_name: null, status: "ativo" },
    origin: { name: "YouCon Sul de Minas" }, commercial: { name: "YouCon Sul de Minas" }, delivery: { name: "YouCon Sul de Minas" },
    services: [svc("int", "Design de Interiores", "Interiores", "interiors", "completed", d(-160))], team: [], allocations: [] },
];

const INTAKES: any[] = [
  { id: "in1", source: "pipefy", external_id: "1029385111", intake_kind: "new_project", target_external_id: null, client_name: "Gustavo Lima Arquitetura", client_email: null, client_phone: "(35) 98888-1122",
    client_document: null, client_type: null, project_name: "Sede administrativa", project_type: "Comercial", services: ["Projeto Arquitetonico", "Ar condicionado"], resolved_services: null,
    contracted_at: d(0), contract_value: 48500, area_m2: 620, city: "Varginha", state: "MG", address: null, salesperson: "Thiago", notes: null,
    status: "error", validation_error: "Tipo de cliente não informado (B2C ou B2B).",
    validation_details: { errors: ["Tipo de cliente não informado (B2C ou B2B).", "Serviço não reconhecido: Ar condicionado"] },
    received_at: new Date(Date.now() - 3600e3).toISOString(), processed_at: null, created_project_id: null,
    raw_payload: { card_id: "1029385111", cliente: "Gustavo Lima Arquitetura", servicos: "Projeto Arquitetonico, Ar condicionado", valor: "48.500,00" } },
  { id: "in2", source: "pipefy", external_id: "1029384999", intake_kind: "new_project", target_external_id: null, client_name: "Construtora Horizonte", client_email: "obras@horizonte.com.br", client_phone: null,
    client_document: "12345678000190", client_type: "b2b", project_name: "Galpão logístico", project_type: "Industrial", services: ["Estudo de Viabilidade", "SPDA", "Combate a Incêndio"], resolved_services: ["via", "spda", "inc"],
    contracted_at: d(-1), contract_value: 132000, area_m2: 4200, city: "Pouso Alegre", state: "MG", address: null, salesperson: "Mariana", notes: null,
    status: "processed", validation_error: null, validation_details: null, received_at: d(-1) + "T10:00:00Z", processed_at: d(-1) + "T10:00:01Z", created_project_id: "pr9",
    raw_payload: { card_id: "1029384999" } },
  { id: "in3", source: "pipefy", external_id: "1029384756", intake_kind: "new_project", target_external_id: null, client_name: "Ricardo e Helena Tavares", client_email: "ricardo.tavares@gmail.com", client_phone: null,
    client_document: null, client_type: "b2c", project_name: "Casa de campo", project_type: "Residencial", services: ["Projeto Arquitetônico", "Projeto Estrutural", "Projeto Elétrico", "Projeto Hidrossanitário"], resolved_services: [],
    contracted_at: d(-2), contract_value: 61800, area_m2: 286.5, city: "Caldas", state: "MG", address: null, salesperson: "Thiago", notes: null,
    status: "processed", validation_error: null, validation_details: null, received_at: d(-2) + "T14:10:00Z", processed_at: d(-2) + "T14:10:01Z", created_project_id: "pr8",
    raw_payload: { card_id: "1029384756" } },
  { id: "in4", source: "pipefy", external_id: "1029380000", intake_kind: "new_project", target_external_id: null, client_name: "Teste Pipefy", client_email: null, client_phone: null,
    client_document: null, client_type: null, project_name: null, project_type: null, services: [], resolved_services: null,
    contracted_at: null, contract_value: null, area_m2: null, city: null, state: null, address: null, salesperson: null, notes: null,
    status: "ignored", validation_error: "Card de teste", validation_details: null, received_at: d(-5) + "T09:00:00Z", processed_at: null, created_project_id: null, raw_payload: {} },
];

const ROLES = [
  { code: "project_lead", name: "Líder do Projeto", sort_order: 1, required: true, active: true },
  { code: "architecture", name: "Arquitetura", sort_order: 2, required: false, active: true },
  { code: "engineering", name: "Engenharia", sort_order: 3, required: false, active: true },
  { code: "interiors", name: "Interiores", sort_order: 4, required: false, active: true },
  { code: "approval", name: "Aprovação", sort_order: 5, required: false, active: true },
  { code: "consulting", name: "Consultoria", sort_order: 6, required: false, active: true },
];


// ---------- Etapa 3: cronograma simulado ----------
const addBiz = (start: string, days: number) => {
  const dt = new Date(`${start}T12:00:00`);
  while (dt.getDay() === 0 || dt.getDay() === 6) dt.setDate(dt.getDate() + 1);
  let left = days - 1;
  while (left > 0) { dt.setDate(dt.getDate() + 1); if (dt.getDay() !== 0 && dt.getDay() !== 6) left--; }
  return dt.toISOString().slice(0, 10);
};
const nextBiz = (date: string) => addBiz(new Date(new Date(`${date}T12:00:00`).getTime() + 86400000).toISOString().slice(0, 10), 1);

const TRACKS: any[] = [];
const TASKS: any[] = [];
const DEPS: any[] = [];
function track(id: string, projectId: string, psId: string, svc: { id: string; name: string; code: string; family: string; fs: number }, status: string, tpl: any, start: string,
  defs: [string, string, number | null, string?, string?][], done = 0, resp: (string | null)[] = []) {
  TRACKS.push({ id, project_id: projectId, project_service_id: psId, status, status_note: status === "awaiting_area" ? "Área necessária para definir cronograma." : null,
    planned_start_date: null, planned_end_date: null, actual_start_date: null, actual_end_date: null, created_at: start + "T10:00:00Z",
    template: tpl, project_service: { id: psId, status: "active", service: { id: svc.id, name: svc.name, code: svc.code, family: { name: svc.family, sort_order: svc.fs } } } });
  let cur = start; let prev: string | null = null; let unknown = false;
  defs.forEach(([code, name, days, type = "fixed", st], i) => {
    const tid = `${id}-${code}`;
    const s0 = unknown ? null : cur;
    const e0 = s0 && days ? addBiz(s0, days) : null;
    if (!e0 && type !== "ongoing") unknown = true;
    const status = st ?? (i < done ? "completed" : i === done ? "in_progress" : i === done + 1 ? "not_started" : "not_started");
    TASKS.push({ id: tid, schedule_track_id: id, project_id: projectId, code, name, description: null, sequence: (i + 1) * 10, duration_type: type,
      planned_duration_days: days, planned_start_date: s0, planned_end_date: e0, actual_start_date: i <= done && status !== "not_started" && s0 ? s0 : null,
      actual_end_date: status === "completed" ? e0 : null, status, status_changed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
      responsible_user_id: resp[i] === undefined ? resp[0] ?? null : resp[i], waiting_reason: status === "waiting_client" ? "Aguardando planta do condomínio" : null,
      notes: null, start_not_before: null, auto_skipped: false, client_visible: true,
      cycle_kind: code.includes("__fb") ? "feedback" : code.includes("__rev") ? "revision" : null });
    if (prev) DEPS.push({ id: `d-${tid}`, task_id: tid, depends_on_task_id: prev, dependency_type: "finish_to_start", lag_days: 0, source: "template" });
    prev = tid; if (e0) cur = nextBiz(e0);
  });
  const tt = TASKS.filter((t) => t.schedule_track_id === id);
  const tr = TRACKS.find((t) => t.id === id);
  tr.planned_start_date = tt[0]?.planned_start_date ?? null;
  tr.planned_end_date = tt.every((t) => t.planned_end_date) ? tt.at(-1)?.planned_end_date ?? null : null;
}
track("tr-arq", "pr1", "ps-arq", { id: "arq", name: "Projeto Arquitetônico", code: "projeto_arquitetonico", family: "Arquitetura", fs: 10 }, "in_progress",
  { name: "Projeto Arquitetônico", version: 1 }, d(-46),
  [["planejamento", "Planejamento", 20], ["envio_briefing", "Envio do Briefing", 7], ["estudo_preliminar", "Estudo Preliminar", 20],
   ["estudo_preliminar__fb0", "Feedback do cliente · Estudo Preliminar", 2], ["estudo_preliminar__rev1", "Revisão 1", 5], ["estudo_preliminar__fb1", "Feedback do cliente · Revisão 1", 2],
   ["estudo_preliminar__rev2", "Revisão 2", 5], ["estudo_preliminar__fb2", "Feedback do cliente · Revisão 2", 2], ["estudo_preliminar__rev3", "Revisão 3", 5], ["estudo_preliminar__fb3", "Feedback do cliente · Revisão 3", 2],
   ["alteracoes", "Alterações", 30], ["imagens_3d_video", "Imagens 3D e Vídeo", 10]],
  2, ["p-c1", "p-c1", "p-c1", "p-c1", "p-c1", "p-c1", "p-c1", "p-c1", "p-c1", "p-c1", "p-c1", "p-pj"]);
track("tr-int", "pr1", "ps-int", { id: "int", name: "Design de Interiores", code: "design_interiores", family: "Interiores", fs: 40 }, "in_progress",
  { name: "Design de Interiores — até 500 m²", version: 1 }, d(-12),
  [["planejamento", "Planejamento", 10], ["envio_briefing", "Envio do Briefing", 5, "fixed", "waiting_client"], ["projeto_interiores", "Projeto de Interiores", 10],
   ["alteracao", "Alteração", 15], ["renderizacao", "Renderização", 10], ["detalhamento", "Detalhamento", 15], ["assessoria", "Assessoria", 5]], 1, ["p-c2"]);
track("tr-est", "pr1", "ps-est", { id: "est", name: "Projeto Estrutural", code: "projeto_estrutural", family: "Engenharia", fs: 20 }, "planned",
  { name: "Projeto Estrutural", version: 1 }, d(-46),
  [["briefing_arq_apr_eng", "Briefing Arq + Apr + Eng", 3, "fixed", "completed"], ["producao_arquitetura", "Tempo de Produção da Arquitetura", 25, "dependent", "in_progress"],
   ["revisao_apr_arq_eng", "Revisão APR x ARQ x ENG", 2], ["planejamento", "Planejamento", 10], ["producao_disciplina", "Produção da disciplina", null],
   ["compatibilizacao", "Compatibilização", null], ["executivo", "Executivo", null]], 0, ["p-pj"]);
DEPS.push({ id: "d-x1", task_id: "tr-est-producao_arquitetura", depends_on_task_id: "tr-arq-estudo_preliminar__fb3", dependency_type: "finish_to_start", lag_days: 0, source: "template" });
// atraso proposital para a visão geral
{ const t = TASKS.find((x) => x.id === "tr-arq-estudo_preliminar"); t.planned_end_date = d(-2); }

const CHANGES: any[] = [
  { id: "c1", task_id: "tr-arq-estudo_preliminar", change_type: "duration", before: { planned_start_date: d(-30), planned_end_date: d(-6), planned_duration_days: 15 },
    after: { planned_start_date: d(-30), planned_end_date: d(-2), planned_duration_days: 20 }, reason: "Cliente pediu uma rodada extra de layout", impacted_task_ids: ["a", "b", "c"],
    created_at: new Date(Date.now() - 3 * 86400000).toISOString(), author: { name: "Rafael Andrade" } },
  { id: "c2", task_id: "tr-arq-estudo_preliminar", change_type: "status", before: { status: "ready" }, after: { status: "in_progress" }, reason: null, impacted_task_ids: [],
    created_at: new Date(Date.now() - 9 * 86400000).toISOString(), author: { name: "Beatriz Nogueira" } },
];

const AUTOMATIONS: any[] = [
  { id: "au1", name: "Avisar quando uma etapa atrasar", trigger: "task_overdue", conditions: {}, active: true, archived: false, run_count: 4,
    last_run_at: "2026-10-06T10:07:00Z", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z",
    actions: [{ type: "notify", recipients: ["owner", "task_responsible"], title: "Etapa atrasada: {etapa}", message: "{projeto} ({codigo}) · {servico}" }] },
  { id: "au2", name: "Estudo aprovado vai para revisão", trigger: "task_completed",
    conditions: { steps: ["estudo preliminar"], services: ["projeto_arquitetonico"] }, active: true, archived: false, run_count: 2,
    last_run_at: "2026-10-05T15:30:00Z", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z",
    actions: [{ type: "move_card", column_id: "bc3" }, { type: "notify", recipients: ["project_lead"], title: "{etapa} concluído", message: "{projeto}" }] },
  { id: "au3", name: "Imagens 3D para o renderista", trigger: "task_started", conditions: { steps: ["alteracoes"] }, active: false, archived: false,
    run_count: 0, last_run_at: null, created_at: "2026-10-02T10:00:00Z", updated_at: "2026-10-02T10:00:00Z",
    actions: [{ type: "set_task_responsible", step: "Imagens 3D e Vídeo", assignee: "user:p-pj2" }] },
];
const AUTO_RUNS: any[] = [
  { id: "ar1", rule_id: "au1", event: "task_overdue", project_id: "pr1", task_id: null, ok: true, created_at: "2026-10-06T10:07:00Z",
    results: [{ type: "notify", ok: true, message: "2 aviso(s) enviado(s)" }], context: { task_name: "Estudo Preliminar", service_name: "Projeto Arquitetônico" },
    project: { id: "pr1", name: "Residência Souza", code: "YC-2026-0014" }, rule: { name: "Avisar quando uma etapa atrasar" } },
  { id: "ar2", rule_id: "au2", event: "task_completed", project_id: "pr2", task_id: null, ok: false, created_at: "2026-10-05T15:30:00Z",
    results: [{ type: "move_card", ok: false, message: "Coluna não encontrada" }, { type: "notify", ok: true, message: "1 aviso(s) enviado(s)" }],
    context: { task_name: "Estudo Preliminar", service_name: "Projeto Arquitetônico" },
    project: { id: "pr2", name: "Clínica Vida", code: "YC-2026-0019" }, rule: { name: "Estudo aprovado vai para revisão" } },
];
const NOTIFS: any[] = [
  { id: "n1", kind: "automation", title: "Etapa atrasada: Estudo Preliminar", body: "Residência Souza (YC-2026-0014) · Projeto Arquitetônico", entity_type: "projects", entity_id: "pr1", data: {}, read_at: null, created_at: new Date(Date.now() - 50 * 60000).toISOString() },
  { id: "n2", kind: "task_assigned", title: "Nova etapa sob sua responsabilidade", body: "Renderização · Clínica Vida", entity_type: "project_tasks", entity_id: "x", data: {}, read_at: null, created_at: new Date(Date.now() - 5 * 3600000).toISOString() },
  { id: "n3", kind: "project_awaiting_team", title: "Novo projeto aguardando equipe", body: "Casa de campo", entity_type: "projects", entity_id: "pr8", data: {}, read_at: "2026-10-05T12:00:00Z", created_at: "2026-10-05T11:00:00Z" },
];
const BOARD_COLS: any[] = [];
const BOARD_CARDS: any[] = [];
const LIBRARY: any[] = ["Planejamento", "Envio do Briefing", "Estudo Preliminar", "Alterações", "Imagens 3D e Vídeo", "Projeto Executivo", "Imagens 3D", "Vídeo 3D", "Detalhamento",
  "Renderização", "Compatibilização", "Projeto Legal", "Verificação"].map((name, i) => ({ id: `lib-${i}`, name, description: null, family_id: null,
  default_duration_days: i < 5 ? [20, 7, 20, 30, 10][i] : null, duration_type: "fixed", active: true, created_by: null, created_at: "2026-10-05T12:00:00Z", sort_order: (i + 1) * 10 }));
LIBRARY[LIBRARY.length - 1].active = false;

const REASONS: any[] = ([
  ["Solicitação do cliente", true], ["Cliente pediu alteração em etapa já concluída", true], ["Aguardando aprovação ou retorno do cliente", true],
  ["Atraso no envio de informações ou documentos pelo cliente", true], ["Alteração de escopo solicitada pelo cliente", true],
  ["Inclusão de novo serviço (aditivo)", true], ["Prazo de órgão público ou concessionária", true],
  ["Dependência de fornecedor ou terceiro", true], ["Revisão técnica ou compatibilização entre projetos", true],
  ["Reorganização interna da equipe", false], ["Antecipação de prazo", true], ["Outro motivo", true],
] as [string, boolean][]).map(([label, vis], i, all) => ({ id: `rs-${i}`, kind: "schedule", label, description: null, client_visible: vis,
  is_other: i === all.length - 1, sort_order: i === all.length - 1 ? 1000 : (i + 1) * 10, active: true }));
([
  ["waiting_client", ["Aguardando aprovação do cliente", "Aguardando medidas ou levantamento do local", "Aguardando documentos do imóvel", "Aguardando definições do cliente (layout, acabamentos)", "Aguardando pagamento"]],
  ["waiting_third_party", ["Aguardando prefeitura ou órgão público", "Aguardando concessionária (energia, água, gás)", "Aguardando topografia ou sondagem", "Aguardando fornecedor ou consultor externo"]],
  ["waiting_dependency", ["Aguardando outro setor da YouCon", "Informação técnica pendente", "Conflito entre disciplinas a resolver", "Responsável indisponível no momento"]],
  ["task_cancel", ["Etapa não se aplica a este projeto", "Escopo alterado pelo cliente", "Cliente desistiu do serviço", "Etapa feita fora da plataforma"]],
  ["adjustment_reject", ["Solução já aprovada pelo cliente", "Resolver na compatibilização", "Fora do escopo contratado", "Pedido sem informação suficiente: reenviar com detalhes"]],
  ["intake_ignore", ["Card de teste", "Venda duplicada", "Venda cancelada antes do início", "Lançada por engano"]],
] as [string, string[]][]).forEach(([kind, labels]) => labels.forEach((label, i) => REASONS.push({
  id: `rs-${kind}-${i}`, kind, label, description: null, client_visible: false, is_other: false, sort_order: (i + 1) * 10, active: true })));
const PROJECT_TYPES: any[] = ["Residencial", "Comercial", "Corporativo", "Industrial", "Institucional", "Hotelaria"]
  .map((name, i) => ({ id: `pt-${i}`, name, sort_order: (i + 1) * 10, active: true }));

/** Imagem de exemplo (planta esquemática) para os anexos da prévia. */
function mockImage(i: number) {
  const hue = [20, 200, 140, 280][i % 4];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='420' viewBox='0 0 640 420'>`
    + `<rect width='640' height='420' fill='hsl(${hue},12%,88%)'/>`
    + `<g fill='none' stroke='hsl(${hue},20%,35%)' stroke-width='6'><rect x='60' y='50' width='520' height='320'/><line x1='300' y1='50' x2='300' y2='250'/><line x1='60' y1='250' x2='420' y2='250'/></g>`
    + `<circle cx='300' cy='250' r='26' fill='none' stroke='%23ff3000' stroke-width='6'/>`
    + `<text x='320' y='310' font-family='sans-serif' font-size='26' fill='hsl(${hue},20%,30%)'>Detalhe ${i + 1}</text></svg>`;
  return `data:image/svg+xml;utf8,${svg.replace(/#/g, "%23")}`;
}

const NOTES: any[] = [
  { id: "n1", task_id: "tr-arq-estudo_preliminar", body: "Cliente pediu para ver duas opções de fachada antes de fechar o estudo.", created_at: d(-2) + "T15:10:00Z", author: { name: "Beatriz Nogueira" } },
  { id: "n2", task_id: "tr-arq-estudo_preliminar", body: "Ok, priorizar a opção com varanda gourmet.", created_at: d(-1) + "T09:30:00Z", author: { name: "Rafael Andrade" } },
];

const COMPLEXITIES: any[] = [
  { code: "simple", label: "Alteração simples", default_days: 3, description: "Ajuste pontual, sem impacto em outras partes do projeto.", sort_order: 1 },
  { code: "medium", label: "Alteração média", default_days: 7, description: "Ajuste que envolve mais de um ambiente ou prancha.", sort_order: 2 },
  { code: "complex", label: "Alteração complexa", default_days: 15, description: "Ajuste que muda a concepção ou exige nova compatibilização.", sort_order: 3 },
];
const ADJUSTMENTS: any[] = [
  { id: "adj1", project_id: "pr1", project_name: "Residência Souza", project_code: "YC-2026-0014", task_id: "tr-arq-envio_briefing", task_name: "Envio do Briefing",
    task_status: "completed", target_service: "Projeto Arquitetônico", from_service: "Projeto Estrutural", complexity: "medium", complexity_label: "Alteração média",
    requested_days: 7, description: "Pilar central conflita com a laje da sala de estar. Precisamos ajustar o vão e reposicionar a escada antes de seguir com o cálculo.",
    attachments: [{ path: "pr1/adj1/a.jpg", name: "pilar-sala.jpg", size: 420000, type: "image/jpeg" }, { path: "pr1/adj1/b.jpg", name: "corte-escada.png", size: 380000, type: "image/png" }],
    status: "pending", requested_by: { id: "p-c2", name: "Camila Rocha" }, decided_by: null, decided_at: null, decision_note: null, approved_days: null,
    assignee: null, result: null, created_at: d(0) + "T13:10:00Z", approvers: [{ id: "p-l1", name: "Rafael Andrade" }], can_decide: true, can_cancel: false },
  { id: "adj2", project_id: "pr1", project_name: "Residência Souza", project_code: "YC-2026-0014", task_id: "tr-arq-planejamento", task_name: "Planejamento",
    task_status: "completed", target_service: "Projeto Arquitetônico", from_service: "Design de Interiores", complexity: "simple", complexity_label: "Alteração simples",
    requested_days: 3, description: "Revisar a cota do pé-direito da sala para o forro de gesso.", status: "approved",
    requested_by: { id: "p-c3", name: "Lucas Ferreira" }, decided_by: { id: "p-l1", name: "Rafael Andrade" }, decided_at: d(-6) + "T10:00:00Z",
    decision_note: "Ok, a Beatriz resolve esta semana.", approved_days: 2, assignee: { id: "p-c1", name: "Beatriz Nogueira" },
    result: { mode: "reopened", impacted_count: 5 }, created_at: d(-7) + "T16:20:00Z", approvers: [{ id: "p-l1", name: "Rafael Andrade" }], can_decide: false, can_cancel: false },
  { id: "adj3", project_id: "pr1", project_name: "Residência Souza", project_code: "YC-2026-0014", task_id: "tr-arq-planejamento", task_name: "Planejamento",
    task_status: "completed", target_service: "Projeto Arquitetônico", from_service: "Projeto Estrutural", complexity: "complex", complexity_label: "Alteração complexa",
    requested_days: 15, description: "Trocar a laje maciça por nervurada em todo o pavimento superior.", status: "rejected",
    requested_by: { id: "p-c2", name: "Camila Rocha" }, decided_by: { id: "p-l1", name: "Rafael Andrade" }, decided_at: d(-12) + "T09:00:00Z",
    decision_note: "Solução já aprovada pelo cliente; resolver na compatibilização.", approved_days: null, assignee: null, result: null,
    created_at: d(-13) + "T11:00:00Z", approvers: [{ id: "p-l1", name: "Rafael Andrade" }], can_decide: false, can_cancel: false },
];

const CLIENT_CHANGES: any[] = [
  { id: "cc0", project_id: "pr1", project_name: "Residência Souza", task_name: "Envio do Briefing", service_name: "Projeto Arquitetônico",
    change_type: "reopened", reason: "Cliente pediu alteração em etapa já concluída", reason_detail: "Inclusão de um quarto de hóspedes no programa",
    before_start: d(-44), before_end: d(-33), after_start: d(0), after_end: d(6), impacted_count: 9, changed_at: d(0) + "T11:30:00Z" },
  { id: "cc1", project_id: "pr1", project_name: "Residência Souza", task_name: "Estudo Preliminar", service_name: "Projeto Arquitetônico",
    change_type: "duration", reason: "Aguardando aprovação ou retorno do cliente", reason_detail: "Reunião de apresentação remarcada para o dia 14",
    before_start: d(-30), before_end: d(-2), after_start: d(-30), after_end: d(3), impacted_count: 4, changed_at: d(-3) + "T14:20:00Z" },
  { id: "cc2", project_id: "pr1", project_name: "Residência Souza", task_name: "Planejamento", service_name: "Design de Interiores",
    change_type: "reschedule", reason: "Inclusão de novo serviço (aditivo)", reason_detail: null,
    before_start: d(-20), before_end: d(5), after_start: d(-10), after_end: d(15), impacted_count: 6, changed_at: d(-12) + "T10:05:00Z" },
  { id: "cc3", project_id: "pr1", project_name: "Residência Souza", task_name: "Envio do Briefing", service_name: "Projeto Arquitetônico",
    change_type: "duration", reason: "Família em viagem durante as duas primeiras semanas", reason_detail: null,
    before_start: d(-44), before_end: d(-40), after_start: d(-44), after_end: d(-33), impacted_count: 9, changed_at: d(-41) + "T09:00:00Z" },
  { id: "cc4", project_id: "pr1", project_name: "Residência Souza", task_name: "Cálculo estrutural", service_name: "Projeto Estrutural",
    change_type: "duration", reason: "Antecipação de prazo", reason_detail: null,
    before_start: d(10), before_end: d(40), after_start: d(10), after_end: d(35), impacted_count: 2, changed_at: d(-1) + "T16:40:00Z" },
];

const FAMILIES = [["arquitetura", "Arquitetura"], ["engenharia", "Engenharia"], ["orcamentos", "Orçamentos"], ["interiores", "Interiores"], ["aprovacoes", "Aprovações e Trâmites"],
  ["b2b_desenvolvimento", "B2B / Desenvolvimento"], ["obra", "Obra"]].map(([code, name], i) => ({ id: `f-${code}`, code, name, sort_order: (i + 1) * 10, active: true }));
const CATALOG = [
  ["arq", "f-arquitetura", "projeto_arquitetonico", "Projeto Arquitetônico", true, true, true],
  ["est", "f-engenharia", "projeto_estrutural", "Projeto Estrutural", true, true, true],
  ["ele", "f-engenharia", "projeto_eletrico", "Projeto Elétrico", true, true, true],
  ["spda", "f-engenharia", "spda", "SPDA", false, true, true],
  ["oe", "f-orcamentos", "orcamento_estimativo", "Orçamento Estimativo", true, true, false],
  ["int", "f-interiores", "design_interiores", "Design de Interiores", true, true, true],
  ["apr", "f-aprovacoes", "aprovacao_projeto_legal", "Aprovação / Projeto Legal", true, true, true],
].map(([id, family_id, code, name, b2c, b2b, has], i) => ({ id, family_id, code, name, description: null, available_for_b2c: b2c, available_for_b2b: b2b,
  has_schedule_template: has, requires_area_rule: code === "design_interiores",
  leadership_area: family_id === "f-engenharia" || family_id === "f-orcamentos" ? "engineering" : family_id === "f-aprovacoes" ? "approval" : "architecture", sort_order: i * 10, active: true, aliases: code === "projeto_arquitetonico" ? ["Arquitetura"] : [] }));
function CATALOG_SERVICES_FOR_DOCS() { return CATALOG.map((c) => ({ code: c.code, name: c.name, family: FAMILIES.find((f) => f.id === c.family_id)?.name ?? "" })); }
const tplTasks = (tid: string, defs: [string, string, number | null, string?][]) => defs.map(([code, name, days, type = "fixed"], i) => ({
  id: `${tid}-${code}`, template_id: tid, code, name, description: null, sort_order: (i + 1) * 10, default_duration_days: days, duration_type: type,
  include_if_service_codes: code === "compatibilizacao_interiores" ? ["design_interiores"] : null, client_visible: true, active: true,
  review_cycle: ["estudo_preliminar", "projeto_interiores"].includes(code), review_days: ["estudo_preliminar", "projeto_interiores"].includes(code) ? 5 : null,
  feedback_days: code === "estudo_preliminar" ? 2 : null }));
const TEMPLATES: any[] = [
  { id: "t-arq2", service_id: "arq", name: "Projeto Arquitetônico", version: 2, client_type: null, area_min: null, area_max: null, status: "published", active: true,
    notes: "Inclui levantamento no local", published_at: d(-20), created_at: d(-21),
    tasks: tplTasks("t-arq2", [["planejamento", "Planejamento", 20], ["levantamento", "Levantamento no local", 3], ["envio_briefing", "Envio do Briefing", 7],
      ["estudo_preliminar", "Estudo Preliminar", 20], ["alteracoes", "Alterações", 30], ["imagens_3d_video", "Imagens 3D e Vídeo", 10]]) },
  { id: "t-arq1", service_id: "arq", name: "Projeto Arquitetônico", version: 1, client_type: null, area_min: null, area_max: null, status: "archived", active: false,
    notes: "Versão inicial — padrão YouCon", published_at: "2026-10-05", created_at: "2026-10-05", tasks: [] },
  { id: "t-est", service_id: "est", name: "Projeto Estrutural", version: 1, client_type: null, area_min: null, area_max: null, status: "published", active: true,
    notes: "Versão inicial — padrão YouCon", published_at: "2026-10-05", created_at: "2026-10-05",
    tasks: tplTasks("t-est", [["briefing_arq_apr_eng", "Briefing Arq + Apr + Eng", 3], ["producao_arquitetura", "Tempo de Produção da Arquitetura", null, "dependent"],
      ["revisao_apr_arq_eng", "Revisão APR x ARQ x ENG", 2], ["planejamento", "Planejamento", 10], ["producao_disciplina", "Produção da disciplina", null],
      ["compatibilizacao", "Compatibilização", null], ["executivo", "Executivo", null], ["compatibilizacao_interiores", "Compatibilização para interiores", null]]) },
  { id: "t-int1", service_id: "int", name: "Design de Interiores — até 500 m²", version: 1, client_type: null, area_min: null, area_max: 500, status: "published", active: true,
    notes: null, published_at: "2026-10-05", created_at: "2026-10-05",
    tasks: tplTasks("t-int1", [["planejamento", "Planejamento", 10], ["envio_briefing", "Envio do Briefing", 5], ["projeto_interiores", "Projeto de Interiores", 10], ["alteracao", "Alteração", 15]]) },
  { id: "t-int2", service_id: "int", name: "Design de Interiores — acima de 500 m²", version: 1, client_type: null, area_min: 500, area_max: null, status: "published", active: true,
    notes: null, published_at: "2026-10-05", created_at: "2026-10-05",
    tasks: tplTasks("t-int2", [["planejamento", "Planejamento", 15], ["envio_briefing", "Envio do Briefing", 7], ["layout_modelagem", "Layout + Modelagem", 15]]) },
  { id: "t-ele1", service_id: "ele", name: "Projeto Elétrico", version: 1, client_type: null, area_min: null, area_max: null, status: "draft", active: false,
    notes: null, published_at: null, created_at: "2026-10-06",
    tasks: tplTasks("t-ele1", [["planejamento", "Planejamento", 5], ["producao_disciplina", "Produção da disciplina", 15]]) },
];
const TEMPLATE_DEPS: any[] = [{ id: "td1", template_task_id: "t-est-producao_arquitetura", predecessor_task_id: null, predecessor_service_code: "projeto_arquitetonico", predecessor_task_code: "estudo_preliminar", active: true }];
// Arquitetura v2: fase 5 com "Alterações" e "Imagens 3D e Vídeo" simultâneas
const seqDep = (tid: string, a: string, b: string) => TEMPLATE_DEPS.push({ id: `${tid}-${a}-${b}`, template_task_id: `${tid}-${a}`, predecessor_task_id: `${tid}-${b}`, predecessor_service_code: null, predecessor_task_code: null, active: true });
seqDep("t-arq2", "levantamento", "planejamento"); seqDep("t-arq2", "envio_briefing", "levantamento"); seqDep("t-arq2", "estudo_preliminar", "envio_briefing");
seqDep("t-arq2", "alteracoes", "estudo_preliminar");
["revisao_apr_arq_eng", "planejamento", "producao_disciplina", "compatibilizacao", "executivo", "compatibilizacao_interiores"].forEach((c, i, a) =>
  seqDep("t-est", c, i === 0 ? "producao_arquitetura" : a[i - 1]));
seqDep("t-est", "producao_arquitetura", "briefing_arq_apr_eng");
seqDep("t-int1", "envio_briefing", "planejamento"); seqDep("t-int1", "projeto_interiores", "envio_briefing"); seqDep("t-int1", "alteracao", "projeto_interiores");
seqDep("t-int2", "envio_briefing", "planejamento"); seqDep("t-int2", "layout_modelagem", "envio_briefing");
seqDep("t-ele1", "producao_disciplina", "planejamento"); seqDep("t-arq2", "imagens_3d_video", "estudo_preliminar");

PROJECTS.forEach((p) => p.services.forEach((x: any) => {
  const r = p.id === "pr1" ? RESP[x.service.id] : undefined;
  x.responsible_user_id = r?.[0] ?? null;
  x.responsible = r ? { id: r[0], name: r[1], avatar_url: null, employment_type: r[2] } : null;
  x.service.family.sort_order = x.service.family.name === "Arquitetura" ? 10 : x.service.family.name === "Engenharia" ? 20 : 40;
}));

function alertsView() {
  const today = new Date().toISOString().slice(0, 10);
  return TASKS.map((t) => {
    const p = PROJECTS.find((x) => x.id === t.project_id);
    const tr = TRACKS.find((x) => x.id === t.schedule_track_id);
    const due = t.planned_end_date ? Math.round((new Date(`${t.planned_end_date}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86400000) : null;
    const open = !["completed", "cancelled"].includes(t.status);
    return { task_id: t.id, project_id: t.project_id, task_name: t.name, status: t.status, responsible_user_id: t.responsible_user_id,
      planned_start_date: t.planned_start_date, planned_end_date: t.planned_end_date, project_name: p?.name, project_code: p?.code, service_name: tr?.project_service.service.name,
      due_in_days: due, overdue_days: open && due != null && due < 0 ? -due : null, waiting_days: ["waiting_client", "waiting_dependency", "waiting_third_party"].includes(t.status) ? 5 : null,
      is_overdue: open && due != null && due < 0, is_blocked: ["waiting_dependency", "waiting_third_party"].includes(t.status), is_waiting_client: t.status === "waiting_client",
      is_unassigned: open && !t.responsible_user_id };
  });
}

function mySteps() {
  const p = me(); if (!p) return [];
  return TASKS.filter((t) => t.responsible_user_id === p.id && t.status !== "cancelled").map((t) => {
    const pr = PROJECTS.find((x) => x.id === t.project_id);
    const tr = TRACKS.find((x) => x.id === t.schedule_track_id);
    return { id: t.id, name: t.name, status: t.status, project_id: t.project_id, project_name: pr?.name, project_code: pr?.code ?? null,
      client_name: pr?.client?.name ?? null, service_name: tr?.project_service.service.name,
      planned_start_date: t.planned_start_date, planned_end_date: t.planned_end_date, planned_duration_days: t.planned_duration_days, duration_type: t.duration_type,
      actual_start_date: t.actual_start_date, actual_end_date: t.actual_end_date, start_not_before: t.start_not_before, waiting_reason: t.waiting_reason,
      reopen_count: t.reopen_count ?? 0, status_changed_at: t.status_changed_at };
  }).sort((a, b) => (a.planned_end_date ?? "9999").localeCompare(b.planned_end_date ?? "9999"));
}
const WORK_ITEMS: any[] = [];
function seedWorkItems() {
  if (WORK_ITEMS.length) return;
  const mine = TASKS.filter((t) => t.responsible_user_id === "p-c1" && t.status !== "completed");
  const at = (n: number, h = 0) => new Date(Date.now() + n * 86400000 + h * 3600000).toISOString();
  const add = (title: string, due: string, task: any = null, done_at: string | null = null, owner = "p-c1", by: string | null = null, description: string | null = null) =>
    WORK_ITEMS.push({ id: `wi${WORK_ITEMS.length + 1}`, owner_id: owner, title, description, due_date: due, done_at, project_task_id: task?.id ?? null,
      project_id: task?.project_id ?? null, created_at: at(-3), assigned_by: by, assigned_at: by ? at(-3) : null });
  add("Enviar planta revisada para o cliente", d(-2), mine[0]);
  add("Ligar para a construtora sobre o levantamento", d(-1));
  add("Revisar cortes e fachadas do estudo", d(0), mine[0]);
  add("Separar referências para a renderização", d(0), null);
  add("Conferir medidas do levantamento", d(0), mine[0], at(0, -2));
  add("Reunião de alinhamento com a engenharia", d(1));
  // Atribuídas pela liderança
  add("Atualizar memorial descritivo", d(-1), mine[0], null, "p-c1", "p-ld", "Usar o modelo novo da pasta Padrões e conferir áreas.");
  add("Ajustar layout da cozinha conforme reunião", d(0), mine[1], null, "p-c1", "p-ld");
  add("Organizar acervo de pranchas do 2º trimestre", d(3), null, null, "p-c1", "p-ld");
  add("Levantamento fotográfico do terreno", d(-3), null, null, "p-c2", "p-ld", "Fotos das divisas e da calçada.");
  add("Conferir quantitativos do orçamento", d(0), null, null, "p-c2", "p-ld");
  add("Enviar ART para assinatura", d(-4), null, at(-2), "p-c2", "p-ld");
  add("Revisar pranchas elétricas", d(-2), null, at(-2, 2), "p-pj", "p-ld");
  add("Compatibilizar quadro de cargas", d(2), null, null, "p-pj", "p-ua");
  add("Organizar arquivos do Revit", d(-6), null, at(-5), "p-c1", "p-ld");
  add("Revisar propostas comerciais", d(0), null, null, "p-ld");
  add("Visita técnica na obra", d(2), null, null, "p-ld");
  add("Reunião de feedback com a equipe", d(-1), null, at(-1), "p-ld");
}
function workJson(w: any) {
  const prof = (id: string | null) => profiles.find((x) => x.id === id);
  const o = prof(w.owner_id); const a = prof(w.assigned_by);
  const t = TASKS.find((x) => x.id === w.project_task_id); const pr = PROJECTS.find((x) => x.id === w.project_id);
  return { ...w, project_name: pr?.name ?? null, project_code: pr?.code ?? null, step_name: t?.name ?? null,
    owner: o ? { id: o.id, name: o.name, avatar_url: o.avatar_url ?? null, role: o.role, employment_type: o.employment_type } : null,
    assigned_by: a ? { id: a.id, name: a.name } : null };
}
const canLead = (me: any, t: any) => !!me && !!t && me.id !== t.id && ["leader", "unit_admin", "global_admin"].includes(me.role)
  && ["collaborator", "leader", "unit_admin"].includes(t.role) && (me.role === "global_admin" || me.tenant_id === t.tenant_id)
  && ["collaborator", "leader", "unit_admin", "global_admin"].indexOf(t.role) <= ["collaborator", "leader", "unit_admin", "global_admin"].indexOf(me.role);
function teamWork() {
  seedWorkItems(); const p = me();
  return WORK_ITEMS.filter((w) => w.assigned_by && (w.assigned_by === p?.id || canLead(p, profiles.find((x) => x.id === w.owner_id))))
    .map(workJson).sort((a, b) => a.due_date.localeCompare(b.due_date));
}

// ---------- Funções da equipe ----------
let JOB_FNS: any[] = [["jf-est", "Engenheiro", "Estrutural"], ["jf-ele", "Engenheiro", "Elétrico"], ["jf-hid", "Engenheiro", "Hidráulico"],
  ["jf-arq", "Arquiteto", "Arquitetônico"], ["jf-int", "Arquiteto", "Interiores"]].map(([id, profession, specialty], i) => ({ id, tenant_id: HQ, profession, specialty, sort_order: (i + 1) * 10 }));
const fnLabel = (f: any) => f.specialty ? `${f.profession} › ${f.specialty}` : f.profession;
const ROLE_NAME: Record<string, string> = { lead_architecture: "Líder de Arquitetura", lead_engineering: "Líder de Engenharia", lead_approval: "Líder de Aprovação",
  architecture: "Arquitetura", engineering: "Engenharia", interiors: "Interiores", approval: "Aprovação", support: "Colaborador indireto" };
function clientTeam(projectId: string) {
  const pr = PROJECTS.find((x) => x.id === projectId); if (!pr) return [];
  const map = new Map<string, any>();
  pr.team.filter((t: any) => t.active).forEach((t: any) => {
    const prof = profiles.find((x) => x.id === t.user.id); if (!prof) return;
    const m = map.get(prof.id) ?? { id: prof.id, name: prof.name, avatar_url: null, bio: prof.bio, is_leader: false, roles: [], areas: [],
      functions: JOB_FNS.filter((f) => (prof.function_ids ?? []).includes(f.id)).map(fnLabel) };
    if (t.project_role.startsWith("lead_")) { m.is_leader = true; m.roles.push(ROLE_NAME[t.project_role]); }
    else if (t.project_role !== "support") m.areas.push(ROLE_NAME[t.project_role]);
    map.set(prof.id, m);
  });
  pr.services.forEach((x: any) => { if (x.responsible && map.has(x.responsible.id)) map.get(x.responsible.id).roles.push(`Responsável por ${x.service.name}`); });
  return [...map.values()].sort((a, b) => Number(b.is_leader) - Number(a.is_leader) || a.name.localeCompare(b.name));
}

// ---------- Setores da empresa ----------
let SECTORS: any[] = [["s-arq", "Arquitetura"], ["s-eng", "Engenharia"], ["s-int", "Interiores"], ["s-apr", "Aprovação"]]
  .map(([id, name], i) => ({ id, tenant_id: HQ, name, sort_order: (i + 1) * 10 }));
const sectorList = (t: string) => SECTORS.filter((x) => x.tenant_id === t).sort((a, b) => a.sort_order - b.sort_order)
  .map((x) => ({ id: x.id, name: x.name, sort_order: x.sort_order, people: profiles.filter((p) => p.sector_id === x.id && p.status === "ativo").length }));

// ---------- Performance (dados sintéticos e estáveis por pessoa/mês) ----------
let PERF_SET: any = { tenant_id: HQ, weight_delivery: 60, weight_on_time: 30, weight_no_backlog: 10, band_ok: 70, band_great: 90, min_volume: 3,
  include_assigned_tasks: true, highlight_includes_pj: false };
const PERF_ACTS: Record<string, string[]> = {
  "s-arq": ["Planejamento", "Envio do Briefing", "Estudo Preliminar", "Alterações", "Imagens 3D e Vídeo"],
  "s-eng": ["Projeto Estrutural", "Projeto Elétrico", "Projeto Hidrossanitário", "Compatibilização Estrutural", "Correção de projeto"],
  "s-int": ["Planejamento", "Briefing", "Projeto de Interiores", "Renderização", "Detalhamento"],
};
const PERF_PROFILE: Record<string, [number, number]> = { // [entrega base, pontualidade base]
  "p-ld": [0.8, 0.9], "p-c1": [0.75, 0.66], "p-a2": [0.95, 0.95], "p-a3": [0.6, 0.55], "p-c2": [0.85, 0.8], "p-pj": [1, 1], "p-e2": [0.9, 0.85],
  "p-i1": [0.92, 0.9], "p-i2": [0.7, 0.75], "p-ua": [0, 0],
};
const monthStart = (iso?: string | null) => (iso ? iso.slice(0, 8) + "01" : new Date().toISOString().slice(0, 8) + "01");
const shiftM = (iso: string, n: number) => { const [y, m] = iso.split("-").map(Number); const dt = new Date(y, m - 1 + n, 1); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-01`; };
function rnd(seed: string) { let h = 2166136261; for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000) / 1000; }
function perfRow(p: any, month: string): any {
  const base = PERF_PROFILE[p.id] ?? [0.8, 0.8];
  const sector = SECTORS.find((f) => f.id === p.sector_id);
  const acts = (PERF_ACTS[p.sector_id] ?? ["Etapas de projeto"]).map((label, i) => {
    const planned = base[0] === 0 ? 0 : 1 + Math.floor(rnd(p.id + month + i) * 4);
    const delivered = Math.min(planned + (rnd(month + p.id + i) > 0.85 ? 1 : 0), Math.round(planned * Math.min(1.1, base[0] + (rnd(i + p.id + month) - 0.5) * 0.3)));
    const on_time = Math.round(delivered * Math.min(1, base[1] + (rnd(month + i + p.id + "t") - 0.5) * 0.2));
    return { key: label.toLowerCase(), label, is_task: false, planned, delivered, on_time };
  });
  if (base[0] > 0) { const tp = 1 + Math.floor(rnd(p.id + month + "task") * 3); const td = Math.round(tp * base[0]); acts.push({ key: "tarefas da lideranca", label: "Tarefas da liderança", is_task: true, planned: tp, delivered: td, on_time: Math.round(td * base[1]) }); }
  const sum = (k: string) => acts.reduce((a: number, x: any) => a + x[k], 0);
  const planned = sum("planned"), delivered = sum("delivered"), on_time = sum("on_time");
  const late_open = Math.max(0, Math.round((planned - Math.min(delivered, planned)) * 0.7));
  const c = planned ? Math.min(1, delivered / planned) : null, t = delivered ? on_time / delivered : null, bk = planned || late_open ? Math.max(0, 1 - late_open / Math.max(planned, 1)) : null;
  const S = PERF_SET; const parts: [number | null, number][] = [[c, S.weight_delivery], [t, S.weight_on_time], [bk, S.weight_no_backlog]];
  const den = parts.reduce((a, [v, w]) => a + (v == null ? 0 : w), 0);
  const score = den ? Math.round(100 * parts.reduce((a, [v, w]) => a + (v ?? 0) * w, 0) / den) : null;
  return { id: p.id, name: p.name, avatar_url: null, role: p.role, employment_type: p.employment_type, tenant_id: p.tenant_id,
    sector: sector ? { id: sector.id, name: sector.name } : null, planned, delivered, on_time, late_open, late_days_avg: delivered > on_time ? 2.5 : null,
    delivery_pct: c == null ? null : Math.round(c * 100), on_time_pct: t == null ? null : Math.round(t * 100), no_backlog_pct: bk == null ? null : Math.round(bk * 100),
    score, band: score == null ? null : score >= S.band_great ? "great" : score >= S.band_ok ? "ok" : "low", activities: acts.filter((a: any) => a.planned || a.delivered) };
}
const perfStaff = () => profiles.filter((x) => x.tenant_id === HQ && x.status === "ativo" && ["collaborator", "leader", "unit_admin"].includes(x.role));
function perfTrend(people: any[], month: string) {
  const out: Record<string, any[]> = {};
  people.forEach((p) => { out[p.id] = Array.from({ length: 6 }, (_, i) => { const m = shiftM(month, i - 5); const r = perfRow(p, m); return { month: m, score: r.score, band: r.band }; }); });
  return out;
}
function perfOverview(m?: string | null) {
  const me0 = me(); if (!me0) return null;
  const manager = ["leader", "unit_admin", "global_admin"].includes(me0.role);
  if (!manager && me0.employment_type !== "clt") return null;
  const month = monthStart(m);
  const people = manager ? perfStaff().filter((x) => x.id !== me0.id || me0.employment_type === "clt") : [me0];
  const end = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).toISOString().slice(0, 10);
  return { month, month_end: end, cut: end, tenant_id: HQ, settings: PERF_SET, scope: manager ? "team" : "self",
    can_configure: ["unit_admin", "global_admin"].includes(me0.role), can_set_sector: manager,
    sectors: sectorList(HQ).map((f) => ({ id: f.id, name: f.name })), people: people.map((p) => perfRow(p, month)), trend: perfTrend(people, month) };
}
function perfPerson(id: string, m?: string | null) {
  const p = profiles.find((x) => x.id === id); const month = monthStart(m); const row = perfRow(p, month);
  const late = Array.from({ length: row.late_open }, (_, i) => ({ kind: i % 2 ? "task" : "step", id: `l${i}`, title: i % 2 ? "Organizar acervo de pranchas" : (row.activities[i]?.label ?? "Etapa"),
    project_id: "pr1", project: "YC-2026-0014", due: d(-(i + 2)), status: "in_progress", days: i + 2 }));
  const delivered = Array.from({ length: Math.min(row.delivered, 8) }, (_, i) => ({ kind: "step", id: `d${i}`, title: row.activities[i % row.activities.length]?.label ?? "Etapa",
    project_id: "pr1", project: i % 2 ? "YC-2026-0019" : "YC-2026-0014", due: d(-(i * 2 + 1)), done: d(-(i * 2 + (i % 3 === 0 ? 0 : 1))), late_days: i % 3 === 0 ? 1 : 0 }));
  return { month, month_end: month, cut: month, person: row, trend: perfTrend([p], month)[p.id], late, delivered };
}
function perfHighlights(m?: string | null) {
  const me0 = me(); if (!me0) return null;
  const manager = ["leader", "unit_admin", "global_admin"].includes(me0.role);
  if (!manager && me0.employment_type !== "clt") return null;
  const month = monthStart(m);
  const rows = perfStaff().filter((x) => x.sector_id && (x.employment_type === "clt" || PERF_SET.highlight_includes_pj)).map((p) => perfRow(p, month))
    .filter((r) => r.score != null && r.planned >= PERF_SET.min_volume);
  const best = new Map<string, any>();
  rows.forEach((r) => { const b = best.get(r.sector.id); if (!b || r.score > b.score || (r.score === b.score && r.delivered > b.delivered)) best.set(r.sector.id, r); });
  return { month, settings: PERF_SET, items: [...best.values()].sort((a, b) => a.sector.name.localeCompare(b.sector.name))
    .map((r) => ({ sector: r.sector, person: { id: r.id, name: r.name, avatar_url: null }, score: r.score, band: r.band, planned: r.planned, delivered: r.delivered, on_time_pct: r.on_time_pct })) };
}

function visibleRows(table: string): any[] {
  const p = me();
  if (!p) return [];
  const global = p.role === "global_admin";
  if (table === "projects") {
    if (currentKey() === "empty") return [];
    const list = PROJECTS.filter((x) => global || x.delivery_tenant_id === p.tenant_id || x.commercial_tenant_id === p.tenant_id);
    return p.role === "collaborator" ? list.filter((x) => x.team.some((t: any) => t.user?.id === p.id)) : list;
  }
  if (table === "project_intakes") return currentKey() === "empty" ? [] : INTAKES;
  if (table === "project_roles") return ROLES;
  if (table === "project_schedule_tracks") return TRACKS;
  if (table === "project_tasks") return TASKS;
  if (table === "task_dependencies") return DEPS;
  if (table === "task_changes") return CHANGES;
  if (table === "task_notes") return NOTES;
  if (table === "work_items") { seedWorkItems(); return WORK_ITEMS.filter((w) => w.owner_id === p.id).sort((a, b) => a.due_date.localeCompare(b.due_date)); }
  if (table === "task_alerts") return alertsView().filter((a) => {
    if (p.role === "collaborator") return a.responsible_user_id === p.id;
    return true;
  });
  if (table === "task_library") return LIBRARY;
  if (table === "schedule_change_reasons") return REASONS;
  if (table === "adjustment_complexities") return COMPLEXITIES;
  if (table === "automation_rules") return AUTOMATIONS;
  if (table === "automation_runs") return AUTO_RUNS;
  if (table === "notifications") return NOTIFS;
  if (table === "project_board_columns") return [...BOARD_COLS].sort((a, b) => a.sort_order - b.sort_order);
  if (table === "project_board_cards") return BOARD_CARDS;
  if (table === "service_families") return FAMILIES;
  if (table === "faq_categories") return FAQ_CATS.filter((x) => !x.archived_at).sort((a, b) => a.sort_order - b.sort_order);
  if (table === "faq_items") return FAQ_ITEMS.filter((x) => !x.archived_at).sort((a, b) => a.sort_order - b.sort_order);
  if (table === "faq_feedback") return global ? FAQ_FB : [];
  if (table === "job_functions") return JOB_FNS.filter((x) => global || x.tenant_id === p.tenant_id).sort((a, b) => a.sort_order - b.sort_order);
  if (table === "sectors") return SECTORS.filter((x) => global || x.tenant_id === p.tenant_id).sort((a, b) => a.sort_order - b.sort_order);
  if (table === "schedule_templates") return TEMPLATES;
  if (table === "template_task_dependencies") return TEMPLATE_DEPS;
  if (table === "template_tasks") return TEMPLATES.filter((t) => t.active).flatMap((t) => t.tasks.map((x: any) => ({ ...x,
    template: { active: true, service: CATALOG.find((c) => c.id === t.service_id) } })));
  if (table === "services") return CATALOG.map((s: any) => ({ ...s, family: FAMILIES.find((f: any) => f.id === s.family_id) ?? null }));
  if (table === "service_packages") return [{ name: "Projetos Complementares", aliases: ["Complementares"], description: "Elétrico, Hidrossanitário e SPDA", active: true }];
  if (table === "project_types") return PROJECT_TYPES;
  if (table === "project_team") {
    return PROJECTS.flatMap((x) => x.team.filter((t: any) => t.active).map((t: any) => ({ active: true, user_id: t.user.id, project_role: t.project_role, project: { id: x.id, name: x.name, status: x.status, delivery_tenant_id: x.delivery_tenant_id } })));
  }
  if (table === "profiles") return profiles.filter((x) => global || x.tenant_id === p.tenant_id || x.id === p.id);
  if (table === "tenants") return tenants.filter((t) => global || t.id === p.tenant_id);
  if (table === "clients") {
    return clients.filter((c) => global || c.tenant_id === p.tenant_id).map((c) => ({
      phone: null, document: null, company_name: null, created_at: "2026-05-01T12:00:00Z", ...c,
      projects: [{ count: PROJECTS.filter((x) => x.client?.id === c.id).length }],
    }));
  }
  return [];
}

function from(table: string) {
  const filters: [string, any][] = [];
  let mode: "select" | "insert" | "update" | "delete" = "select";
  let single = false;
  let payload: any = null;
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (col: string, val: any) => { if (!col.includes(".")) filters.push([col, val]); return q; },
    in: () => q,
    is: () => q,
    not: (col: string, _op: string, val: string) => { const vals = val.replace(/[()]/g, "").split(","); filters.push([col, { notIn: vals }]); return q; },
    limit: () => q,
    single: () => { single = true; return q; },
    maybeSingle: () => { single = true; return q; },
    insert: (row: any) => { mode = "insert"; payload = row; return q; },
    update: (patch: any) => { mode = "update"; payload = patch; return q; },
    delete: () => { mode = "delete"; return q; },
    then: (resolve: any, reject: any) => {
      let rows = visibleRows(table).filter((r) => filters.every(([c, v]) => (v && typeof v === "object" && v.notIn) ? !v.notIn.includes(r[c]) : r[c] === v));
      if (mode === "insert" && table === "task_library" && single) {
        const item = { id: `lib-new-${Date.now()}`, description: null, family_id: null, active: true, created_at: new Date().toISOString(), sort_order: 9999, ...payload };
        LIBRARY.push(item);
        return delay({ data: item, error: null }).then(resolve, reject);
      }
      if (table === "work_items" && mode !== "select") {
        if (mode === "insert") {
          const task = TASKS.find((t) => t.id === payload.project_task_id);
          const item = { id: `wi${Date.now()}`, owner_id: me()?.id, done_at: null, created_at: new Date().toISOString(), ...payload, project_id: task?.project_id ?? null };
          WORK_ITEMS.push(item);
          return delay({ data: item, error: null }, 150).then(resolve, reject);
        }
        rows.forEach((r) => { if (mode === "update") Object.assign(r, payload); else WORK_ITEMS.splice(WORK_ITEMS.indexOf(r), 1); });
        return delay({ data: null, error: null }, 150).then(resolve, reject);
      }
      const result = mode !== "select" ? { data: null, error: null } : { data: single ? rows[0] ?? null : rows, error: null };
      return delay(result).then(resolve, reject);
    },
  };
  return q;
}

type Listener = (event: string, session: any) => void;
const listeners: Listener[] = [];
const session = () => (me() ? { access_token: "mock", user: { id: me()!.auth_user_id, email: me()!.email } } : null);

export function createClient() {
  return {
    auth: {
      getSession: () => delay({ data: { session: session() }, error: null }, 50),
      onAuthStateChange: (cb: Listener) => { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword: ({ email }: any) => {
        const p = profiles.find((x) => x.email === email);
        if (!p) return delay({ data: null, error: { message: "Invalid login credentials" } }, 400);
        if (p.status !== "ativo") return delay({ data: null, error: { message: "Seu acesso está inativo. Fale com o administrador da sua unidade." } }, 400);
        const key = Object.entries(ROLE_PROFILE).find(([, v]) => v === p.id)?.[0];
        if (key) sessionStorage.setItem("mock-as", key);
        setTimeout(() => listeners.forEach((l) => l("SIGNED_IN", session())), 0);
        return delay({ data: {}, error: null }, 400);
      },
      signOut: async () => { sessionStorage.removeItem("mock-as"); history.replaceState(null, "", location.pathname); listeners.forEach((l) => l("SIGNED_OUT", null)); return { error: null }; },
      resetPasswordForEmail: () => delay({ data: {}, error: null }, 400),
      updateUser: () => delay({ data: {}, error: null }, 400),
    },
    rpc,
    from,
    storage: {
      from: (_bucket: string) => ({
        upload: () => delay({ data: {}, error: null }, 300),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `/${path}` } }),
        createSignedUrl: (_path: string) => delay({ data: { signedUrl: mockImage(0) }, error: null }, 120),
        createSignedUrls: (paths: string[]) => delay({ data: paths.map((path, i) => ({ path, signedUrl: mockImage(i), error: null })), error: null }, 120),
      }),
    },
    functions: {
      invoke: (_name: string, { body }: any) => {
        if (body.action === "invite" && profiles.some((p) => p.email === body.email)) {
          return delay({ data: null, error: { context: new Response(JSON.stringify({ message: "Já existe um usuário com este e-mail" })) } }, 500);
        }
        if (body.action === "invite") {
          profiles = [...profiles, { id: `p-${Date.now()}`, auth_user_id: null, tenant_id: body.tenant_id, name: body.name, email: body.email, role: body.role, employment_type: body.employment_type ?? null, client_type: body.client_type ?? null, status: "ativo", phone: null, avatar_url: null, invited_at: new Date().toISOString(), last_seen_at: null, created_at: new Date().toISOString() }];
        }
        if (body.action === "client_access_add") {
          if (CACCESS.some((x) => x.email === body.email.toLowerCase())) return delay({ data: null, error: { context: new Response(JSON.stringify({ message: `${body.name} já tem acesso a este projeto` })) } }, 400);
          CACCESS.push({ id: `ca${Date.now()}`, profile_id: `pc${Date.now()}`, name: body.name, email: body.email.toLowerCase(), relation: body.relation, scope: body.all_projects ? "all" : "projects",
            can_decide: body.can_decide, is_primary: false, is_me: false, status: "pending", projects: body.all_projects ? null : 1, invited_by: me()?.name ?? null, can_edit: true });
          return delay({ data: { contact_id: "x", invited: true, new_user: true }, error: null }, 500);
        }
        if (body.action === "set_status") profiles = profiles.map((p) => p.id === body.profile_id ? { ...p, status: body.status } : p);
        if (body.action === "update") profiles = profiles.map((p) => p.id === body.profile_id ? { ...p, name: body.name, role: body.role, employment_type: body.employment_type, client_type: body.client_type } : p);
        return delay({ data: { ok: true }, error: null }, 500);
      },
    },
  };
}
