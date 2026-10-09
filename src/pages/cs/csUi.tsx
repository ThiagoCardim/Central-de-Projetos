import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync } from "@/hooks";
import { Link } from "@/lib/router";
import { Alert, Avatar, Badge, Button, Field, Input, Segmented, Skeleton } from "@/components/ui/primitives";
import { Drawer, Modal, useToast } from "@/components/ui/overlays";
import { Icon, type IconName } from "@/components/ui/Icon";
import { OptionPicker } from "@/components/ui/OptionPicker";
import { cx, formatDate, formatDateTime, type Tone } from "@/utils/format";
import type { CsKind, CsRequest, CsStatus, CsUrgency } from "@/types/domain";

/* ==========================================================================
   Customer Success: rótulos, chamado (novo e conversa)
   ========================================================================== */
export const CS_KIND: Record<CsKind, { label: string; short: string; icon: IconName; hint: string }> = {
  clarification: { label: "Esclarecimento do andamento", short: "Esclarecimento", icon: "search", hint: "Entender a situação do projeto ou de uma etapa." },
  client_question: { label: "Dúvida do cliente", short: "Dúvida do cliente", icon: "help", hint: "O cliente perguntou algo e a equipe precisa responder." },
  alert: { label: "Alerta para a equipe", short: "Alerta", icon: "alert", hint: "Situação que precisa ser respondida, corrigida ou esclarecida rápido." },
};
export const CS_URGENCY: Record<CsUrgency, { label: string; tone: Tone }> = {
  normal: { label: "Normal", tone: "neutral" }, high: { label: "Alta", tone: "warning" }, urgent: { label: "Urgente", tone: "danger" },
};
export const CS_STATUS: Record<CsStatus, { label: string; tone: Tone }> = {
  open: { label: "Aguardando equipe", tone: "warning" }, answered: { label: "Respondido", tone: "brand" },
  resolved: { label: "Encerrado", tone: "success" }, cancelled: { label: "Cancelado", tone: "neutral" },
};

/** "vence em 3 h", "venceu há 2 dias" */
export function dueText(r: Pick<CsRequest, "due_at" | "status" | "first_response_at">): { text: string; late: boolean } {
  if (r.first_response_at) return { text: `respondido ${formatDateTime(r.first_response_at)}`, late: false };
  const ms = new Date(r.due_at).getTime() - Date.now();
  const abs = Math.abs(ms);
  const h = Math.round(abs / 36e5);
  const span = abs < 36e5 ? `${Math.max(1, Math.round(abs / 6e4))} min` : h < 48 ? `${h} h` : `${Math.round(h / 24)} dias`;
  return ms >= 0 ? { text: `responder em ${span}`, late: false } : { text: `prazo vencido há ${span}`, late: true };
}

export function CsStatusBadge({ r }: { r: Pick<CsRequest, "status" | "overdue"> }) {
  if (r.overdue) return <Badge tone="danger" dot>Prazo vencido</Badge>;
  return <Badge tone={CS_STATUS[r.status].tone} dot>{CS_STATUS[r.status].label}</Badge>;
}

export function KindTag({ kind, urgency }: { kind: CsKind; urgency: CsUrgency }) {
  return (
    <span className={cx("cskind", `cskind--${kind}`, urgency === "urgent" && "is-urgent")}>
      <Icon name={CS_KIND[kind].icon} size={13} />{CS_KIND[kind].short}
      {urgency !== "normal" && <span className="cskind__urg">{CS_URGENCY[urgency].label}</span>}
    </span>
  );
}

/** Linha de chamado (listas do painel, página e projeto). */
export function CsRow({ r, onOpen, showProject = true }: { r: CsRequest; onOpen: () => void; showProject?: boolean }) {
  const due = dueText(r);
  const open = r.status === "open" || r.status === "answered";
  return (
    <li className={cx("csrow", r.overdue && "is-late", r.urgency === "urgent" && open && "is-urgent")}>
      <button type="button" className="csrow__btn" onClick={onOpen}>
        <span className="csrow__top">
          <KindTag kind={r.kind} urgency={r.urgency} />
          <CsStatusBadge r={r} />
        </span>
        <span className="csrow__title">{r.title}</span>
        <span className="csrow__meta">
          {showProject && <><b>{r.project_name}</b>{r.client_name ? ` · ${r.client_name}` : ""} · </>}
          {r.task ? `${r.task.name} · ` : ""}
          {open ? <span className={cx(due.late && "text-danger")}>{due.text}</span> : `encerrado ${formatDate(r.resolved_at, true)}`}
        </span>
        {r.last_message && (
          <span className="csrow__last"><Icon name={r.last_message.from_cs ? "headset" : "users"} size={12} />
            <b>{r.last_message.author}:</b> {r.last_message.body}</span>
        )}
      </button>
    </li>
  );
}

/* ---------- Novo chamado ---------- */
export function NewRequestModal({ open, onClose, onCreated, projectId, defaultKind = "clarification" }: {
  open: boolean; onClose: () => void; onCreated: (id: string) => void; projectId?: string | null; defaultKind?: CsKind;
}) {
  const toast = useToast();
  const { permissions } = useAuth();
  const projects = useAsync(() => (open && !projectId ? api.listProjects() : Promise.resolve([])), [open, projectId]);
  const [project, setProject] = useState(projectId ?? "");
  const [kind, setKind] = useState<CsKind>(defaultKind);
  const [urgency, setUrgency] = useState<CsUrgency>(defaultKind === "alert" ? "urgent" : "normal");
  const [task, setTask] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sla = useAsync(() => (open && permissions?.tenant_id ? api.csSettings(permissions.tenant_id).catch(() => null) : Promise.resolve(null)), [open]);
  const schedule = useAsync(() => (open && project ? api.getProjectSchedule(project) : Promise.resolve(null)), [open, project]);

  useEffect(() => {
    if (!open) return;
    setProject(projectId ?? ""); setKind(defaultKind); setUrgency(defaultKind === "alert" ? "urgent" : "normal");
    setTask(""); setTitle(""); setBody(""); setErr(null);
  }, [open, projectId, defaultKind]);

  const projectOptions = useMemo(() => (projects.data ?? [])
    .filter((p) => ["in_progress", "on_hold", "awaiting_team_assignment", "completed"].includes(p.status))
    .map((p) => ({ value: p.id, label: p.name, hint: p.code ?? undefined, keywords: `${p.client?.name ?? ""} ${p.code ?? ""}` })), [projects.data]);
  const taskOptions = useMemo(() => {
    const s = schedule.data;
    if (!s) return [];
    const svc = new Map(s.tracks.map((t) => [t.id, t.project_service?.service?.name ?? "Serviço"]));
    return s.tasks.filter((t) => t.status !== "cancelled").sort((a, b) => a.sequence - b.sequence)
      .map((t) => ({ value: t.id, label: t.name, group: svc.get(t.schedule_track_id), hint: t.planned_end_date ? formatDate(t.planned_end_date) : undefined }));
  }, [schedule.data]);

  const days = (n: number) => `${n} ${n > 1 ? "dias úteis" : "dia útil"}`;
  const slaText = sla.data
    ? urgency === "urgent" ? `${sla.data.urgent_hours} horas` : days(urgency === "high" ? sla.data.high_days : sla.data.normal_days)
    : null;
  const valid = !!project && title.trim().length >= 3 && body.trim().length >= 3;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const id = await api.csCreate({ project_id: project, kind, urgency, title, body, task_id: task || null });
      toast(kind === "alert" ? "Alerta enviado aos líderes do projeto." : "Chamado enviado aos líderes do projeto.");
      onCreated(id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} wide title={kind === "alert" ? "Criar alerta para a equipe" : "Novo chamado para a equipe"}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon={kind === "alert" ? "alert" : "headset"} variant={kind === "alert" ? "danger" : "primary"} loading={busy} disabled={!valid} onClick={submit}>
          {kind === "alert" ? "Enviar alerta" : "Enviar chamado"}
        </Button>
      </>}>
      <div className="csnew">
        <div className="csnew__kinds" role="radiogroup" aria-label="Tipo">
          {(Object.keys(CS_KIND) as CsKind[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={cx("csnew__kind", `cskind--${k}`, kind === k && "is-on")}
              onClick={() => { setKind(k); if (k === "alert") setUrgency("urgent"); else if (kind === "alert") setUrgency("normal"); }}>
              <Icon name={CS_KIND[k].icon} size={18} />
              <span><b>{CS_KIND[k].label}</b><small>{CS_KIND[k].hint}</small></span>
            </button>
          ))}
        </div>
        {!projectId && (
          <Field label="Projeto" required>
            {({ id }) => <OptionPicker id={id} value={project} onChange={(v) => { setProject(v); setTask(""); }} options={projectOptions}
              loading={projects.loading} placeholder="Escolha o projeto" searchable searchPlaceholder="Buscar projeto, cliente ou código" />}
          </Field>
        )}
        <div className="csnew__row">
          <Field label="Urgência">
            {({ id }) => <Segmented<CsUrgency> id={id} label="Urgência" value={urgency} onChange={setUrgency}
              options={[{ value: "normal", label: "Normal" }, { value: "high", label: "Alta" }, { value: "urgent", label: "Urgente" }]} />}
          </Field>
          <Field label="Etapa relacionada" hint="Opcional">
            {({ id }) => <OptionPicker id={id} value={task} onChange={setTask} options={taskOptions} clearable disabled={!project}
              loading={schedule.loading} placeholder={project ? "Escolha a etapa" : "Escolha o projeto antes"} searchable />}
          </Field>
        </div>
        <Field label="Assunto" required>
          {({ id }) => <Input id={id} value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)}
            placeholder={kind === "client_question" ? "Ex.: Cliente quer saber quando recebe o Estudo Preliminar" : kind === "alert" ? "Ex.: Cliente insatisfeito com o atraso" : "Ex.: Situação da aprovação na prefeitura"} />}
        </Field>
        <Field label={kind === "client_question" ? "O que o cliente perguntou" : "Descreva"} required>
          {({ id }) => <textarea id={id} className="input textarea" rows={5} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />}
        </Field>
        <p className="csnew__note">
          <Icon name="users" size={14} /> Vai para os <b>líderes do projeto</b> (Arquitetura, Engenharia e Aprovação).
          {slaText && <> Prazo de resposta: <b>{slaText}</b>.</>}
        </p>
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Modal>
  );
}

/* ---------- Conversa do chamado ---------- */
export function RequestDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { permissions } = useAuth();
  const q = useAsync(() => (id ? api.csRequest(id) : Promise.resolve(null)), [id]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const r = q.data;
  useEffect(() => { setReply(""); }, [id]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [r?.thread.length]);

  async function act(key: string, fn: () => Promise<void>, msg: string) {
    setBusy(key);
    try { await fn(); toast(msg); await q.reload(); onChanged(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }
  const isCs = !!permissions?.is_cs;
  const open = r && (r.status === "open" || r.status === "answered");
  const due = r ? dueText(r) : null;

  return (
    <Drawer open={!!id} onClose={onClose} wide title={r?.title ?? "Chamado"}
      subtitle={r ? <>{r.project_name}{r.client_name ? ` · ${r.client_name}` : ""}</> : undefined}
      footer={r && r.status !== "cancelled" ? (
        <form className="csreply" onSubmit={(e) => { e.preventDefault(); if (reply.trim()) void act("reply", async () => { await api.csReply(r.id, reply); setReply(""); }, isCs ? "Mensagem enviada à equipe." : "Resposta enviada ao CS."); }}>
          <textarea className="input textarea" rows={2} maxLength={4000} aria-label="Mensagem" value={reply}
            placeholder={isCs ? "Complementar ou perguntar de novo" : "Responder ao CS"}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit(); }} />
          <div className="csreply__actions">
            {r.can_close && <Button size="sm" variant="ghost" icon="check" loading={busy === "close"}
              onClick={() => act("close", () => api.csSetStatus(r.id, "resolved"), "Chamado encerrado.")}>Encerrar</Button>}
            {r.can_reopen && <Button size="sm" variant="ghost" icon="refresh" loading={busy === "reopen"}
              onClick={() => act("reopen", () => api.csSetStatus(r.id, "open"), "Chamado reaberto.")}>Reabrir</Button>}
            <Button size="sm" type="submit" icon="check" loading={busy === "reply"} disabled={!reply.trim()}>{isCs ? "Enviar" : "Responder"}</Button>
          </div>
        </form>
      ) : undefined}>
      {q.loading && !r ? <Skeleton height={240} radius={12} /> : r ? (
        <div className="csd">
          <div className="csd__head">
            <KindTag kind={r.kind} urgency={r.urgency} />
            <CsStatusBadge r={r} />
            {open && due && <span className={cx("csd__due", due.late && "is-late")}><Icon name="clock" size={13} /> {due.text}</span>}
          </div>
          <dl className="kv">
            <div><dt>Projeto</dt><dd><Link to={`/projetos/${r.project_id}`} className="link">{r.project_name}{r.project_code ? ` · ${r.project_code}` : ""}</Link></dd></div>
            {r.task && <div><dt>Etapa</dt><dd>{r.task.name}{r.task.planned_end_date ? ` · previsão ${formatDate(r.task.planned_end_date, true)}` : ""}</dd></div>}
            <div><dt>Para</dt><dd>{r.recipients.length ? r.recipients.map((x) => x.name).join(", ") : "ADM da unidade (projeto sem líder)"}</dd></div>
            <div><dt>Prazo de resposta</dt><dd className="num">{formatDateTime(r.due_at)}</dd></div>
          </dl>
          <div className="csd__thread">
            <Msg name={r.created_by.name} at={r.created_at} body={r.body} cs first />
            {r.thread.map((m) => <Msg key={m.id} name={m.author.name} avatar={m.author.avatar_url} at={m.created_at} body={m.body} cs={m.author.role === "customer_success"} />)}
            <div ref={endRef} />
          </div>
          {r.status === "resolved" && <Alert tone="info">Chamado encerrado em {formatDateTime(r.resolved_at)}.{r.can_reopen ? " Se precisar, reabra." : ""}</Alert>}
        </div>
      ) : <Alert tone="danger">Chamado não encontrado.</Alert>}
    </Drawer>
  );
}

function Msg({ name, avatar, at, body, cs, first }: { name: string; avatar?: string | null; at: string; body: string; cs: boolean; first?: boolean }) {
  return (
    <div className={cx("csmsg", cs ? "is-cs" : "is-team", first && "is-first")}>
      <Avatar name={name} src={avatar ?? null} size="sm" />
      <div className="csmsg__bubble">
        <span className="csmsg__who"><b>{name}</b> {cs ? "· Customer Success" : "· Equipe"} <span className="num">{formatDateTime(at)}</span></span>
        <p>{body}</p>
      </div>
    </div>
  );
}
