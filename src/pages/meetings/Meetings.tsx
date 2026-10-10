import { useEffect, useRef, useState } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync } from "@/hooks";
import { Link, useLocation } from "@/lib/router";
import { Avatar, Badge, Button, Card, Input, Segmented, Select, Skeleton } from "@/components/ui/primitives";
import { Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, firstName, plural } from "@/utils/format";
import type { Meeting, MeetingKind, MeetingLink, MeetingOptions } from "@/types/domain";
import { dateParts, minutesText, SlotPicker, timeOf, whenText } from "./meetingsUi";

/* ==========================================================================
   Reuniões com o cliente (alinhamento ou apresentação de etapa).
   A sala é criada no Google Meet pela conta central da YouCon; a transcrição
   vem ligada e a gravação é opcional. As regras ficam no banco
   (private.meeting_*) e na Edge Function `meetings`.
   ========================================================================== */

const VIA: Record<Meeting["booked_via"], string> = { portal: "pelo portal", team: "pela equipe", link: "pelo link" };

/* ---------- Uma reunião ---------- */
export function MeetingItem({ m, showProject, onChanged }: { m: Meeting; showProject?: boolean; onChanged: () => void }) {
  const { permissions } = useAuth();
  const staff = !!permissions?.is_staff;
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const [manual, setManual] = useState<"link" | "files" | null>(null);
  const [recBusy, setRecBusy] = useState(false);
  const p = dateParts(m.starts_at);
  const open = m.state === "scheduled" || m.state === "live";
  const minutes = Math.round((new Date(m.ends_at).getTime() - new Date(m.starts_at).getTime()) / 60000);

  async function toggleRecord() {
    setRecBusy(true);
    try {
      await api.meetingSetRecord(m.id, !m.record);
      toast(m.record ? "Gravação desligada. A transcrição continua automática." : "Gravação ligada: começa sozinha quando a reunião abrir.");
      onChanged();
    } catch (e) { toast((e as Error).message, "error"); onChanged(); } finally { setRecBusy(false); }
  }

  return (
    <li className={cx("mtg", `is-${m.state}`)}>
      <div className="mtg__date" aria-hidden="true">
        <span className="mtg__wd">{p.weekday}</span>
        <span className="mtg__dd num">{p.day}</span>
        <span className="mtg__mm">{p.month}</span>
      </div>
      <div className="mtg__body">
        <div className="mtg__title">
          <b>{m.task ? `${m.kind_label}: ${m.task.name}` : m.kind_label}</b>
          {m.state === "live" && <Badge tone="brand" dot>Acontecendo agora</Badge>}
          {m.state === "cancelled" && <Badge tone="danger" outline>Cancelada</Badge>}
        </div>
        <div className="mtg__meta">
          <span className="num">{whenText(m.starts_at)} – {timeOf(m.ends_at)}</span>
          <span className="sep" aria-hidden="true" />
          <span>{minutesText(minutes)}</span>
          {showProject && <><span className="sep" aria-hidden="true" /><span className="truncate">{m.project_name}</span></>}
        </div>
        <div className="mtg__who">
          <Avatar name={m.host.name} src={m.host.avatar_url} size="sm" />
          <span>Com <b>{m.host.name}</b>{m.booked_by ? <span className="muted"> · marcada por {firstName(m.booked_by)} {VIA[m.booked_via]}</span> : null}</span>
        </div>
        {staff && m.guest?.email && (
          <p className="subtext mtg__guest"><Icon name="mail" size={14} /> {m.guest.name} · {m.guest.email}{m.guest.phone ? ` · ${m.guest.phone}` : ""}</p>
        )}
        {m.notes && <p className="mtg__notes">{m.notes}</p>}
        {m.state === "cancelled" && m.cancel_reason && <p className="subtext">Motivo: {m.cancel_reason}</p>}

        {open && (
          <div className="mtg__tags">
            <span className="mtg__tag"><Icon name="transcript" size={14} /> Transcrição automática</span>
            {m.record ? <span className="mtg__tag is-rec"><Icon name="record" size={14} /> Gravação ligada</span>
              : staff && <span className="mtg__tag is-off">Sem gravação</span>}
          </div>
        )}

        {/* Sala ainda não criada */}
        {open && !m.meet_uri && (staff ? (
          <p className="dlvnote mtg__note"><Icon name="alertCircle" size={16} />
            <span>{m.google_status === "not_connected" ? "Sala do Meet não criada: a conta Google da YouCon não está conectada." : m.google_status === "pending" ? "Criando a sala do Meet..." : `Sala do Meet não criada${m.google_error ? `: ${m.google_error}` : "."}`}
              {m.can_manage && <> <button type="button" className="link" onClick={() => setManual("link")}>Informar o link da reunião</button></>}</span>
          </p>
        ) : <p className="subtext">O link para entrar será enviado pela equipe e aparece aqui.</p>)}
        {open && staff && m.meet_uri && m.google_error && <p className="subtext mtg__warn"><Icon name="alertCircle" size={14} /> {m.google_error}</p>}

        {/* Depois da reunião: transcrição e gravação */}
        {m.state === "past" && (
          <div className="mtg__files">
            {m.transcript_url && <a className="btn btn--secondary btn--sm" href={m.transcript_url} target="_blank" rel="noreferrer"><Icon name="transcript" /> Transcrição</a>}
            {m.recording_url && <a className="btn btn--secondary btn--sm" href={m.recording_url} target="_blank" rel="noreferrer"><Icon name="video" /> Gravação</a>}
            {staff && !m.transcript_url && (
              <span className="subtext">
                {m.google_status === "created" && (m.artifacts_status === "waiting" || m.artifacts_status === "partial")
                  ? "Transcrição em processamento no Google. Leva de alguns minutos a algumas horas depois do fim."
                  : m.google_status === "created" ? "O Meet não gerou transcrição desta reunião." : "Registre os links da transcrição e da gravação."}
              </span>
            )}
            {staff && m.transcript_url && m.record && !m.recording_url && m.artifacts_status === "partial" && <span className="subtext">Gravação em processamento.</span>}
          </div>
        )}
      </div>

      <div className="mtg__actions">
        {open && m.meet_uri && (
          <a className={cx("btn btn--sm", m.state === "live" ? "btn--primary" : "btn--secondary")} href={m.meet_uri} target="_blank" rel="noreferrer">
            <Icon name="video" /> Entrar
          </a>
        )}
        {open && m.can_manage && m.meet_uri && m.google_status === "created" && (
          <Button size="sm" variant="ghost" icon="record" loading={recBusy} onClick={toggleRecord} title={m.record ? "Desligar a gravação" : "Ligar a gravação"}>
            {m.record ? "Desligar gravação" : "Gravar"}
          </Button>
        )}
        {m.state === "past" && m.can_manage && (
          <Button size="sm" variant="ghost" iconOnly icon="paperclip" onClick={() => setManual("files")}>Registrar transcrição e gravação</Button>
        )}
        {m.can_cancel && <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => setCancelling(true)}>Cancelar reunião</Button>}
      </div>

      {cancelling && <CancelModal m={m} onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); onChanged(); }} />}
      {manual && <ManualModal m={m} mode={manual} onClose={() => setManual(null)} onDone={() => { setManual(null); onChanged(); }} />}
    </li>
  );
}

function CancelModal({ m, onClose, onDone }: { m: Meeting; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.meetingCancel(m.id, reason.trim() || null); toast("Reunião cancelada. Os convidados recebem o aviso por e-mail."); onDone(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Cancelar a reunião?"
      footer={<><Button variant="ghost" onClick={onClose}>Voltar</Button><Button variant="danger" loading={busy} onClick={save}>Cancelar reunião</Button></>}>
      <div className="stack">
        <p>{m.task ? `${m.kind_label}: ${m.task.name}` : m.kind_label}, {whenText(m.starts_at)}, com {m.host.name}. O horário volta a ficar livre e o convite da agenda é cancelado.</p>
        <label className="field">
          <span className="field__label">Motivo <small>(opcional)</small></span>
          <textarea className="input textarea" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: Precisamos remarcar para a próxima semana." />
        </label>
      </div>
    </Modal>
  );
}

function ManualModal({ m, mode, onClose, onDone }: { m: Meeting; mode: "link" | "files"; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState(m.meet_uri ?? "");
  const [transcript, setTranscript] = useState(m.transcript_url ?? "");
  const [recording, setRecording] = useState(m.recording_url ?? "");
  const [busy, setBusy] = useState(false);
  const ok = (v: string) => !v.trim() || /^https?:\/\/\S+$/i.test(v.trim());
  async function save() {
    setBusy(true);
    try {
      if (mode === "link") await api.meetingSetLink(m.id, url);
      else await api.meetingSetArtifacts(m.id, transcript, recording);
      toast(mode === "link" ? "Link da reunião salvo." : "Arquivos da reunião registrados.");
      onDone();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={mode === "link" ? "Link da reunião" : "Transcrição e gravação"}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={busy} disabled={mode === "link" ? !ok(url) : !ok(transcript) || !ok(recording)} onClick={save}>Salvar</Button></>}>
      <div className="stack">
        {mode === "link" ? (
          <>
            <p className="subtext">Use quando a sala não foi criada automaticamente. O link aparece para o cliente no portal.</p>
            <label className="field"><span className="field__label">Link para entrar</span>
              <Input value={url} autoFocus placeholder="https://meet.google.com/..." onChange={(e) => setUrl(e.target.value)} /></label>
          </>
        ) : (
          <>
            <p className="subtext">Os links ficam anexados à reunião no projeto. Use os do Google Drive (com o acesso liberado para quem precisa ver).</p>
            <label className="field"><span className="field__label">Transcrição</span>
              <Input value={transcript} autoFocus placeholder="https://docs.google.com/document/..." onChange={(e) => setTranscript(e.target.value)} /></label>
            <label className="field"><span className="field__label">Gravação <small>(opcional)</small></span>
              <Input value={recording} placeholder="https://drive.google.com/file/..." onChange={(e) => setRecording(e.target.value)} /></label>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ---------- Card de reuniões do projeto ---------- */
export function ProjectMeetingsCard({ projectId, client = false, title }: { projectId: string; client?: boolean; title?: string }) {
  const q = useAsync(() => api.projectMeetings(projectId), [projectId]);
  const { hash } = useLocation();
  const ref = useRef<HTMLElement | null>(null);
  const synced = useRef(false);
  const [booking, setBooking] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const d = q.data;
  const reload = () => void q.reload();

  // Busca no Meet a transcrição/gravação das reuniões que já terminaram (uma vez por abertura).
  useEffect(() => {
    if (!d || synced.current) return;
    if (!d.meetings.some((m) => m.state === "past" && m.google_status === "created" && (m.artifacts_status === "waiting" || m.artifacts_status === "partial"))) return;
    synced.current = true;
    api.meetingSync(projectId).then((r) => { if (r.checked > 0) void q.reload(); }).catch(() => undefined);
  }, [d, projectId, q]);

  useEffect(() => {
    if (d && hash === "#reunioes") ref.current?.querySelector(".card__head")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [d, hash]);

  if (q.error) return null;
  const upcoming = d?.meetings.filter((m) => m.state === "scheduled" || m.state === "live") ?? [];
  const earlier = d?.meetings.filter((m) => m.state === "past" || m.state === "cancelled") ?? [];
  const visibleEarlier = showAll ? earlier : earlier.slice(0, 3);

  return (
    <section ref={ref} id="reunioes" className="mtgcard">
      <Card title={title ?? "Reuniões"} count={upcoming.length || undefined}
        action={d && (d.can_schedule || d.can_share_link) && (
          <div className="row mtgcard__actions">
            {d.can_share_link && d.has_hosts && <Button size="sm" variant="ghost" icon="link" onClick={() => setSharing(true)}>Link para o cliente</Button>}
            {d.can_schedule && <Button size="sm" variant="secondary" icon="calendar" onClick={() => setBooking(true)}>Agendar reunião</Button>}
          </div>
        )}>
        {!d ? <Skeleton height={72} radius={12} /> : (
          <div className="stack mtgcard__body">
            {!client && d.google !== "connected" && (
              <p className="dlvnote"><Icon name="alertCircle" size={16} />
                <span>{d.google === "error" ? "A conexão com o Google precisa ser refeita" : "A conta Google da YouCon ainda não foi conectada"}: as reuniões são marcadas, mas sem sala do Meet nem transcrição automática. O ADM Global conecta em <b>Configurações › Reuniões</b>.</span>
              </p>
            )}
            {d.can_schedule && !d.has_hosts && (
              <p className="dlvnote"><Icon name="clock" size={16} />
                <span>{client ? "A equipe ainda está organizando a agenda deste projeto. Logo os horários aparecem aqui."
                  : <>Ninguém da equipe deste projeto abriu horários ainda. Cada pessoa define os seus em <Link to="/agenda" className="link">Agenda</Link>.</>}</span>
              </p>
            )}
            {d.meetings.length === 0 ? (
              <p className="subtext">{client
                ? "Marque uma reunião de alinhamento ou a apresentação de uma etapa com a equipe. A reunião é on-line e fica registrada aqui, com a transcrição."
                : "Nenhuma reunião ainda. Agende aqui ou envie um link para o cliente escolher o horário."}</p>
            ) : (
              <>
                {upcoming.length > 0 && <ul className="mtg__list">{upcoming.map((m) => <MeetingItem key={m.id} m={m} onChanged={reload} />)}</ul>}
                {earlier.length > 0 && (
                  <>
                    {upcoming.length > 0 && <h3 className="mtgcard__sub">Anteriores</h3>}
                    <ul className="mtg__list">{visibleEarlier.map((m) => <MeetingItem key={m.id} m={m} onChanged={reload} />)}</ul>
                    {earlier.length > 3 && (
                      <button type="button" className="link mtgcard__more" onClick={() => setShowAll(!showAll)}>
                        {showAll ? "Mostrar menos" : `Ver ${plural(earlier.length - 3, "reunião anterior", "reuniões anteriores")}`}
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </Card>
      {booking && <BookModal projectId={projectId} onClose={() => setBooking(false)} onDone={() => { setBooking(false); reload(); }} />}
      {sharing && <ShareLinkModal projectId={projectId} onClose={() => setSharing(false)} />}
    </section>
  );
}

/* ---------- Escolhas comuns: tipo, pessoa e etapa ---------- */
function useHostDefault(o: MeetingOptions | null, setHost: (id: string) => void, host: string | null) {
  const { profile } = useAuth();
  useEffect(() => {
    if (!o || (host && o.hosts.some((h) => h.id === host))) return;
    const pick = o.hosts.find((h) => h.id === profile?.id) ?? o.hosts[0];
    if (pick) setHost(pick.id);
  }, [o, host, profile?.id, setHost]);
}

function KindHostTask({ o, kind, setKind, host, setHost, task, setTask }: {
  o: MeetingOptions; kind: MeetingKind; setKind: (k: MeetingKind) => void; host: string | null; setHost: (id: string) => void;
  task: string; setTask: (id: string) => void;
}) {
  const k = o.kinds.find((x) => x.kind === kind);
  return (
    <>
      <div className="field">
        <span className="field__label">Tipo de reunião</span>
        <Segmented<MeetingKind> label="Tipo de reunião" value={kind} onChange={setKind}
          options={o.kinds.map((x) => ({ value: x.kind, label: x.label }))} />
        <span className="field__hint">{kind === "presentation"
          ? `Apresentação de uma etapa do projeto ao cliente. Duração: ${minutesText(k?.minutes ?? 60)}.`
          : `Para alinhar decisões, dúvidas e próximos passos. Duração: ${minutesText(k?.minutes ?? 60)}.`}</span>
      </div>
      {kind === "presentation" && o.tasks.length > 0 && (
        <label className="field">
          <span className="field__label">Etapa <small>(opcional)</small></span>
          <Select value={task} onChange={(e) => setTask(e.target.value)}>
            <option value="">Sem etapa específica</option>
            {o.tasks.map((t) => <option key={t.id} value={t.id}>{t.service ? `${t.service} · ` : ""}{t.name}</option>)}
          </Select>
        </label>
      )}
      <div className="field">
        <span className="field__label">Com quem</span>
        <div className="mtghosts" role="radiogroup" aria-label="Com quem">
          {o.hosts.map((h) => (
            <button key={h.id} type="button" role="radio" aria-checked={host === h.id} className={cx("mtghost", host === h.id && "is-on")} onClick={() => setHost(h.id)}>
              <Avatar name={h.name} src={h.avatar_url} size="sm" />
              <span className="mtghost__txt"><b>{h.name}</b><small>{h.role}</small></span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/* ---------- Agendar ---------- */
export function BookModal({ projectId, projects, onClose, onDone }: {
  projectId?: string; projects?: { id: string; name: string }[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [project, setProject] = useState(projectId ?? projects?.[0]?.id ?? "");
  const opts = useAsync(() => (project ? api.meetingOptions(project) : Promise.resolve(null)), [project]);
  const o = opts.data && opts.data.project.id === project ? opts.data : null;
  const [kind, setKind] = useState<MeetingKind>("alignment");
  const [host, setHost] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [slot, setSlot] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [record, setRecord] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useHostDefault(o, setHost, host);
  const hostOk = !!o && !!host && o.hosts.some((h) => h.id === host);
  const slots = useAsync(() => (o && host && hostOk ? api.meetingSlots(project, host, kind) : Promise.resolve(null)), [o, host, kind, hostOk]);
  useEffect(() => { setSlot(null); }, [host, kind, project]);
  useEffect(() => { setTask(""); }, [project]);

  async function save() {
    if (!host || !slot) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.meetingBook({ project_id: project, host_id: host, kind, starts_at: slot, task_id: kind === "presentation" ? task || null : null,
        notes: notes.trim() || null, record });
      if (r.google_status === "created") toast(`Reunião marcada para ${whenText(slot)}. O convite com o link do Meet foi enviado por e-mail.`);
      else toast(`Reunião marcada para ${whenText(slot)}. A sala do Meet não foi criada automaticamente: a equipe envia o link.`, "error");
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      void slots.reload();
    } finally { setBusy(false); }
  }

  const hostName = o?.hosts.find((h) => h.id === host)?.name;
  return (
    <Modal open wide onClose={onClose} title="Agendar reunião"
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={busy} disabled={!slot || !host} onClick={save}>{slot ? `Marcar ${whenText(slot)}` : "Escolha um horário"}</Button></>}>
      <div className="stack mtgbook">
        {projects && projects.length > 1 && (
          <label className="field">
            <span className="field__label">Projeto</span>
            <Select value={project} onChange={(e) => setProject(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
        )}
        {opts.error ? <p className="dlvnote is-error"><Icon name="alertCircle" size={16} /><span>{opts.error}</span></p>
          : !o ? <Skeleton height={160} radius={12} />
          : o.hosts.length === 0 ? (
            <p className="dlvnote"><Icon name="clock" size={16} /><span>{o.is_client
              ? "A equipe ainda não abriu horários para este projeto. Tente de novo em breve ou fale com a equipe."
              : "Ninguém da equipe deste projeto abriu horários. Cada pessoa define os seus em Agenda."}</span></p>
          ) : (
            <>
              <KindHostTask o={o} kind={kind} setKind={setKind} host={host} setHost={setHost} task={task} setTask={setTask} />
              <div className="field">
                <span className="field__label">Horário{hostName ? ` livre de ${firstName(hostName)}` : ""}</span>
                <SlotPicker slots={slots.data?.slots ?? null} loading={slots.loading} value={slot} onChange={setSlot}
                  error={slots.error} onRetry={() => void slots.reload()} />
              </div>
              <label className="field">
                <span className="field__label">Pauta <small>(opcional)</small></span>
                <textarea className="input textarea" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)}
                  placeholder={kind === "presentation" ? "Ex.: Apresentar o estudo preliminar e colher os ajustes." : "Ex.: Alinhar o programa de necessidades da área de lazer."} />
              </label>
              {o.can_record ? (
                <label className="pset__check">
                  <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
                  <span><b>Gravar a reunião</b><small>A transcrição já é automática. A gravação fica no Google Drive da YouCon e o link é anexado aqui no projeto.</small></span>
                </label>
              ) : (
                <p className="subtext">A reunião é on-line, pelo Google Meet. Ela é transcrita automaticamente para registrar o que foi combinado. Você recebe o convite por e-mail.</p>
              )}
              {err && <p className="dlvnote is-error"><Icon name="alertCircle" size={16} /><span>{err}</span></p>}
            </>
          )}
      </div>
    </Modal>
  );
}

/* ---------- Link para o cliente escolher o horário ---------- */
const LINK_STATE: Record<MeetingLink["state"], { label: string; tone: "success" | "neutral" | "warning" | "danger" }> = {
  open: { label: "Aberto", tone: "success" }, used: { label: "Usado", tone: "neutral" }, expired: { label: "Expirado", tone: "warning" }, off: { label: "Desativado", tone: "danger" },
};
const linkUrl = (token: string) => `${window.location.origin}/agendar/${token}`;

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function ShareLinkModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const toast = useToast();
  const opts = useAsync(() => api.meetingOptions(projectId), [projectId]);
  const links = useAsync(() => api.projectMeetingLinks(projectId), [projectId]);
  const o = opts.data;
  const [kind, setKind] = useState<MeetingKind>("alignment");
  const [host, setHost] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [days, setDays] = useState("14");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ token: string; expires_at: string } | null>(null);
  useHostDefault(o, setHost, host);

  async function create() {
    if (!host) return;
    setBusy(true);
    try {
      const r = await api.meetingLinkCreate(projectId, host, kind, kind === "presentation" ? task || null : null, Number(days));
      setCreated(r);
      const ok = await copy(linkUrl(r.token));
      toast(ok ? "Link criado e copiado. É só colar na conversa com o cliente." : "Link criado.");
      void links.reload();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  async function disable(l: MeetingLink) {
    try { await api.meetingLinkDisable(l.id); toast("Link desativado."); void links.reload(); }
    catch (e) { toast((e as Error).message, "error"); }
  }

  const url = created ? linkUrl(created.token) : "";
  const wa = created ? `https://wa.me/?text=${encodeURIComponent(`Olá! Escolha o melhor horário para a nossa reunião sobre ${o?.project.name ?? "o seu projeto"}: ${url}`)}` : "";
  return (
    <Modal open wide onClose={onClose} title="Link para o cliente escolher o horário"
      footer={created
        ? <><Button variant="ghost" onClick={() => setCreated(null)}>Criar outro</Button><Button onClick={onClose}>Concluir</Button></>
        : <><Button variant="ghost" onClick={onClose}>Fechar</Button><Button icon="link" loading={busy} disabled={!host} onClick={create}>Criar link</Button></>}>
      <div className="stack">
        {created ? (
          <div className="mtglink">
            <p>Quem abrir o link vê os horários livres e marca a reunião informando nome e e-mail, sem precisar de login. O link vale para <b>uma reunião</b> e expira {whenText(created.expires_at).replace(/ às .*/, "")}.</p>
            <div className="mtglink__url">
              <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Link de agendamento" />
              <Button variant="secondary" icon="copy" onClick={async () => toast((await copy(url)) ? "Link copiado." : "Não deu para copiar. Selecione e copie o link.", "success")}>Copiar</Button>
            </div>
            <a className="btn btn--outline btn--sm" href={wa} target="_blank" rel="noreferrer"><Icon name="chat" /> Enviar pelo WhatsApp</a>
          </div>
        ) : opts.error ? <p className="dlvnote is-error"><Icon name="alertCircle" size={16} /><span>{opts.error}</span></p>
          : !o ? <Skeleton height={160} radius={12} />
          : o.hosts.length === 0 ? <p className="dlvnote"><Icon name="clock" size={16} /><span>Ninguém da equipe deste projeto abriu horários. Defina os seus em Agenda.</span></p>
          : (
            <>
              <p className="subtext">O cliente escolhe entre os horários livres da pessoa escolhida, sem login. A reunião entra no projeto como as demais.</p>
              <KindHostTask o={o} kind={kind} setKind={setKind} host={host} setHost={setHost} task={task} setTask={setTask} />
              <label className="field">
                <span className="field__label">Validade do link</span>
                <Select value={days} onChange={(e) => setDays(e.target.value)}>
                  <option value="3">3 dias</option><option value="7">7 dias</option><option value="14">14 dias</option><option value="30">30 dias</option>
                </Select>
              </label>
            </>
          )}

        {(links.data?.length ?? 0) > 0 && (
          <div className="mtglinks">
            <h3 className="mtgcard__sub">Links deste projeto</h3>
            <ul>
              {links.data!.slice(0, 6).map((l) => (
                <li key={l.id}>
                  <span className="grow">
                    <b>{l.task ? `${l.kind_label}: ${l.task}` : l.kind_label}</b>
                    <small className="subtext">Com {l.host} · criado por {l.created_by ? firstName(l.created_by) : "—"} · {l.state === "open" ? `até ${whenText(l.expires_at).replace(/ às .*/, "")}` : l.state === "used" && l.used_at ? `usado ${whenText(l.used_at).replace(/ às .*/, "")}` : ""}</small>
                  </span>
                  <Badge tone={LINK_STATE[l.state].tone} outline>{LINK_STATE[l.state].label}</Badge>
                  {l.state === "open" && (
                    <>
                      <Button size="sm" variant="ghost" iconOnly icon="copy" onClick={async () => toast((await copy(linkUrl(l.token))) ? "Link copiado." : "Não deu para copiar.")}>Copiar link</Button>
                      <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => disable(l)}>Desativar link</Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------- Cliente: próximas reuniões na tela inicial ---------- */
export function ClientMeetingsCard({ projects }: { projects: { id: string; name: string }[] }) {
  const q = useAsync(() => api.myMeetings(), []);
  const [booking, setBooking] = useState(false);
  if (q.error || projects.length === 0) return null;
  const list = q.data ?? [];
  return (
    <>
      <Card title="Reuniões" count={list.length || undefined}
        action={<div className="row mtgcard__actions">
          <Link to="/reunioes" className="btn btn--ghost btn--sm">Ver todas</Link>
          <Button size="sm" variant="secondary" icon="calendar" onClick={() => setBooking(true)}>Agendar reunião</Button>
        </div>}>
        {!q.data ? <Skeleton height={56} radius={12} /> : list.length === 0 ? (
          <p className="subtext">Precisa alinhar algo ou quer ver a apresentação de uma etapa? Marque uma reunião on-line com a equipe no horário que for melhor para você.</p>
        ) : (
          <ul className="mtg__list">{list.slice(0, 3).map((m) => <MeetingItem key={m.id} m={m} showProject={projects.length > 1} onChanged={() => void q.reload()} />)}</ul>
        )}
      </Card>
      {booking && <BookModal projects={projects} onClose={() => setBooking(false)} onDone={() => { setBooking(false); void q.reload(); }} />}
    </>
  );
}
