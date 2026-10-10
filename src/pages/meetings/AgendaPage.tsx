import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle } from "@/hooks";
import { PageHead } from "@/layouts/AppLayout";
import { Button, Card, EmptyState, Input, LoadError, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, plural } from "@/utils/format";
import type { AvailabilityBlock, AvailabilityRule, MyAvailability } from "@/types/domain";
import { MeetingItem, ProjectMeetingsCard } from "./Meetings";
import { brTime, dayKey, minutesText, timeOf, whenText } from "./meetingsUi";

/* ==========================================================================
   Agenda (equipe): horários disponíveis para reuniões, bloqueios e próximas
   reuniões. Cliente: as reuniões de cada projeto.
   ========================================================================== */
const DAYS = [
  { wd: 1, label: "Segunda" }, { wd: 2, label: "Terça" }, { wd: 3, label: "Quarta" }, { wd: 4, label: "Quinta" },
  { wd: 5, label: "Sexta" }, { wd: 6, label: "Sábado" }, { wd: 0, label: "Domingo" },
];
type Range = { start: string; end: string };
type Week = Record<number, Range[]>;
const DEFAULT_DAY: Range[] = [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }];

function toWeek(rules: AvailabilityRule[]): Week {
  const w: Week = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const r of rules) w[r.weekday].push({ start: r.start, end: r.end });
  return w;
}
function toRules(w: Week): AvailabilityRule[] {
  return DAYS.flatMap((d) => w[d.wd].map((r) => ({ weekday: d.wd, start: r.start, end: r.end })));
}
function dayError(list: Range[]): string | null {
  for (const r of list) {
    if (!/^\d{2}:\d{2}$/.test(r.start) || !/^\d{2}:\d{2}$/.test(r.end)) return "Preencha o início e o fim.";
    if (r.end <= r.start) return "O fim precisa ser depois do início.";
  }
  const s = [...list].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < s.length; i++) if (s[i].start < s[i - 1].end) return "Há faixas sobrepostas neste dia.";
  return null;
}
const hours = (list: Range[]) => list.reduce((a, r) => {
  const [sh, sm] = r.start.split(":").map(Number);
  const [eh, em] = r.end.split(":").map(Number);
  return a + Math.max(0, eh * 60 + em - (sh * 60 + sm));
}, 0);

export function AgendaPage() {
  const { permissions } = useAuth();
  return permissions?.is_staff ? <StaffAgenda /> : <ClientMeetingsPage />;
}

function StaffAgenda() {
  useDocumentTitle("Agenda");
  const q = useAsync(() => api.myAvailability(), []);
  const mine = useAsync(() => api.myMeetings(), []);
  if (q.error) return <div className="page"><LoadError message={q.error} onRetry={() => void q.reload()} /></div>;
  return (
    <div className="page agenda">
      <PageHead title="Agenda" subtitle="Seus horários para reuniões com clientes e as próximas reuniões" />
      {!q.data ? <Skeleton height={320} radius={16} /> : (
        <div className="agenda__grid">
          <div className="stack">
            <WeekCard a={q.data} onSaved={() => void q.reload()} />
            <BlocksCard blocks={q.data.blocks} onChanged={() => void q.reload()} />
          </div>
          <div className="stack">
            <Card title="Próximas reuniões" count={mine.data?.length || undefined}>
              {!mine.data ? <Skeleton height={64} radius={12} /> : mine.data.length === 0
                ? <EmptyState compact icon="calendar" title="Nenhuma reunião marcada." text="Quando um cliente ou a equipe marcar uma reunião com você, ela aparece aqui." />
                : <ul className="mtg__list">{mine.data.map((m) => <MeetingItem key={m.id} m={m} showProject onChanged={() => void mine.reload()} />)}</ul>}
            </Card>
            <aside className="settings__help">
              <h3><Icon name="alertCircle" size={16} /> Como funciona</h3>
              <p>O cliente vê os horários livres das pessoas do projeto: agenda pelo portal ou por um link que a equipe envia.</p>
              <p>Ficam de fora: horários com menos de <b>{plural(q.data.settings.min_notice_hours, "hora", "horas")}</b> de antecedência, feriados, seus bloqueios, outras reuniões (com <b>{minutesText(q.data.settings.buffer_minutes)}</b> de intervalo) e o que estiver ocupado no seu Google Agenda.</p>
              <p>Alinhamento: <b>{minutesText(q.data.settings.alignment_minutes)}</b>. Apresentação: <b>{minutesText(q.data.settings.presentation_minutes)}</b>. Até <b>{q.data.settings.horizon_days} dias</b> à frente.</p>
              <h3><Icon name="video" size={16} /> Na reunião</h3>
              <p>A sala do Google Meet é criada pela conta da YouCon e o convite chega por e-mail a você e ao cliente. A transcrição é automática; a gravação é opcional.</p>
              {q.data.google !== "connected" && <p className="text-warning">A conta Google da YouCon ainda não está conectada: as reuniões são marcadas, mas sem sala do Meet automática.</p>}
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}

function WeekCard({ a, onSaved }: { a: MyAvailability; onSaved: () => void }) {
  const toast = useToast();
  const [week, setWeek] = useState<Week>(() => toWeek(a.rules));
  const [bookable, setBookable] = useState(a.bookable);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setWeek(toWeek(a.rules)); setBookable(a.bookable); }, [a]);

  const errors = useMemo(() => Object.fromEntries(DAYS.map((d) => [d.wd, dayError(week[d.wd])])) as Record<number, string | null>, [week]);
  const invalid = Object.values(errors).some(Boolean);
  const changed = JSON.stringify(toRules(week)) !== JSON.stringify(toRules(toWeek(a.rules))) || bookable !== a.bookable;
  const total = DAYS.reduce((s, d) => s + hours(week[d.wd]), 0);

  const setDay = (wd: number, list: Range[]) => setWeek({ ...week, [wd]: list });
  const copyToWeekdays = (wd: number) => {
    const next = { ...week };
    for (const d of [1, 2, 3, 4, 5]) if (d !== wd) next[d] = week[wd].map((r) => ({ ...r }));
    setWeek(next);
  };

  async function save() {
    setBusy(true);
    try { await api.availabilitySave(toRules(week), bookable); toast("Horários salvos. Já valem para os próximos agendamentos."); onSaved(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }

  return (
    <Card title="Horários disponíveis" className="avail">
      <label className="pset__check avail__bookable">
        <input type="checkbox" checked={bookable} onChange={(e) => setBookable(e.target.checked)} />
        <span><b>Receber agendamentos de clientes</b><small>Desmarcado, ninguém marca reuniões novas com você (as já marcadas continuam).</small></span>
      </label>
      <ul className={cx("avail__week", !bookable && "is-off")}>
        {DAYS.map((d) => {
          const list = week[d.wd];
          const on = list.length > 0;
          return (
            <li key={d.wd} className={cx("avail__day", on && "is-on")}>
              <label className="avail__label">
                <input type="checkbox" checked={on} onChange={(e) => setDay(d.wd, e.target.checked ? DEFAULT_DAY.map((r) => ({ ...r })) : [])} />
                <span>{d.label}</span>
              </label>
              <div className="avail__ranges">
                {!on ? <span className="muted subtext">Indisponível</span> : list.map((r, i) => (
                  <div key={i} className="avail__range">
                    <Input type="time" step={900} value={r.start} aria-label={`${d.label}, início da faixa ${i + 1}`}
                      onChange={(e) => setDay(d.wd, list.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                    <span className="muted">até</span>
                    <Input type="time" step={900} value={r.end} aria-label={`${d.label}, fim da faixa ${i + 1}`}
                      onChange={(e) => setDay(d.wd, list.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                    <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => setDay(d.wd, list.filter((_, j) => j !== i))}>Remover faixa</Button>
                  </div>
                ))}
                {errors[d.wd] && <span className="field__error">{errors[d.wd]}</span>}
              </div>
              <div className="avail__tools">
                {on && <Button size="sm" variant="ghost" iconOnly icon="plus" disabled={list.length >= 6}
                  onClick={() => setDay(d.wd, [...list, { start: list[list.length - 1]?.end ?? "09:00", end: list[list.length - 1]?.end && list[list.length - 1].end < "23:00" ? `${String(Number(list[list.length - 1].end.slice(0, 2)) + 1).padStart(2, "0")}${list[list.length - 1].end.slice(2)}` : "23:59" }])}>Adicionar faixa</Button>}
                {on && d.wd >= 1 && d.wd <= 5 && <Button size="sm" variant="ghost" iconOnly icon="copy" onClick={() => copyToWeekdays(d.wd)}>Copiar {d.label.toLowerCase()} para os dias úteis</Button>}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="settings__save avail__save">
        <span className="subtext">{total > 0 ? `${minutesText(total)} por semana` : "Nenhum horário aberto"}</span>
        <Button icon="check" loading={busy} disabled={!changed || invalid} onClick={save}>Salvar horários</Button>
      </div>
    </Card>
  );
}

function BlocksCard({ blocks, onChanged }: { blocks: AvailabilityBlock[]; onChanged: () => void }) {
  const toast = useToast();
  const today = dayKey(new Date());
  const [f, setF] = useState({ from: today, to: today, allDay: true, start: "09:00", end: "18:00", reason: "" });
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const startsAt = f.allDay ? brTime(f.from, "00:00") : brTime(f.from, f.start);
  const endsAt = f.allDay ? new Date(new Date(brTime(f.to, "00:00")).getTime() + 86400000).toISOString() : brTime(f.to, f.end);
  const valid = !!f.from && !!f.to && endsAt > startsAt;

  async function add() {
    setBusy(true);
    try { await api.availabilityBlockAdd(startsAt, endsAt, f.reason); toast("Bloqueio incluído. Esses horários saem da agenda."); setF({ ...f, reason: "" }); onChanged(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    setRemoving(id);
    try { await api.availabilityBlockRemove(id); toast("Bloqueio removido."); onChanged(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setRemoving(null); }
  }
  const blockText = (b: AvailabilityBlock) => {
    const sameDay = dayKey(b.starts_at) === dayKey(new Date(new Date(b.ends_at).getTime() - 1));
    const allDay = timeOf(b.starts_at) === "00:00" && timeOf(b.ends_at) === "00:00";
    if (allDay) return sameDay ? `${whenText(b.starts_at).replace(/ às .*/, "")}, dia inteiro`
      : `${whenText(b.starts_at).replace(/ às .*/, "")} a ${whenText(new Date(new Date(b.ends_at).getTime() - 1).toISOString()).replace(/ às .*/, "")}`;
    return sameDay ? `${whenText(b.starts_at)} – ${timeOf(b.ends_at)}` : `${whenText(b.starts_at)} a ${whenText(b.ends_at)}`;
  };

  return (
    <Card title="Bloqueios" count={blocks.length || undefined} className="blocks">
      <p className="subtext">Férias, folgas, visitas a obra: os horários bloqueados não aparecem para o cliente.</p>
      <div className="blocks__form">
        <label className="field"><span className="field__label">De</span>
          <Input type="date" value={f.from} min={today} onChange={(e) => setF({ ...f, from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></label>
        <label className="field"><span className="field__label">Até</span>
          <Input type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        {!f.allDay && (
          <>
            <label className="field"><span className="field__label">Das</span><Input type="time" step={900} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
            <label className="field"><span className="field__label">Às</span><Input type="time" step={900} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label>
          </>
        )}
        <label className="field blocks__reason"><span className="field__label">Motivo <small>(opcional, só a equipe vê)</small></span>
          <Input value={f.reason} maxLength={200} placeholder="Ex.: Férias" onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
      </div>
      <div className="blocks__foot">
        <label className="pset__check"><input type="checkbox" checked={f.allDay} onChange={(e) => setF({ ...f, allDay: e.target.checked })} /><span><b>Dia inteiro</b></span></label>
        <Button size="sm" icon="plus" loading={busy} disabled={!valid} onClick={add}>Bloquear</Button>
      </div>
      {blocks.length > 0 && (
        <ul className="blocks__list">
          {blocks.map((b) => (
            <li key={b.id}>
              <Icon name="pause" size={16} />
              <span className="grow"><span className="num">{blockText(b)}</span>{b.reason && <span className="muted"> · {b.reason}</span>}</span>
              <Button size="sm" variant="ghost" iconOnly icon="x" loading={removing === b.id} onClick={() => remove(b.id)}>Remover bloqueio</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------- Cliente: reuniões de cada projeto ---------- */
function ClientMeetingsPage() {
  useDocumentTitle("Reuniões");
  const q = useAsync(() => api.homeDashboard(), []);
  const projects = (q.data?.client?.projects ?? []).map((p) => ({ id: p.id, name: p.name }));
  return (
    <div className="page client">
      <PageHead title="Reuniões" subtitle="Alinhamentos e apresentações com a equipe YouCon" />
      {q.error ? <LoadError message={q.error} onRetry={() => void q.reload()} />
        : !q.data ? <Skeleton height={200} radius={16} />
        : projects.length === 0 ? <EmptyState icon="calendar" title="Nenhum projeto em andamento." text="Quando o seu projeto começar, você marca as reuniões por aqui." />
        : <div className="stack">{projects.map((p) => <ProjectMeetingsCard key={p.id} projectId={p.id} client title={projects.length > 1 ? `Reuniões · ${p.name}` : "Reuniões"} />)}</div>}
    </div>
  );
}
