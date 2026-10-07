import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { api } from "@/services/api";
import { Alert, Avatar, Button, Card, EmptyState, Field, Segmented, Skeleton } from "@/components/ui/primitives";
import { Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import type { ProjectSchedule, SchedulePreview, ScheduleTask, ScheduleTrack, StaffMember } from "@/types/domain";
import { cx, formatDate, plural, TASK_STATUS_LABEL } from "@/utils/format";
import { ImpactPreview } from "./ImpactPreview";
import {
  displayStatus, durationText, isClosed, isStarted, matchesFilters, serviceName, sortTracks, todayISO, type ScheduleFilters,
} from "./model";

/* ==========================================================================
   Datas (dias corridos como números inteiros, em UTC, para não sofrer com fuso)
   ========================================================================== */
const DAY = 86_400_000;
const toDay = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY; };
const fromDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const weekday = (n: number) => new Date(n * DAY).getUTCDay(); // 0 = domingo
const isWeekend = (n: number) => { const w = weekday(n); return w === 0 || w === 6; };
/** Dias úteis (seg–sex) de a até b, inclusive. Feriados são considerados pelo servidor na prévia. */
function businessDays(a: number, b: number): number {
  let n = 0;
  for (let d = a; d <= b; d++) if (!isWeekend(d)) n++;
  return n;
}
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];
const short = (n: number) => { const d = new Date(n * DAY); return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]}`; };

type Scale = "week" | "month" | "quarter";
const DAY_W: Record<Scale, number> = { week: 30, month: 10, quarter: 3.6 };
const ROW_H = 40;
const GROUP_H = 36;
const HEAD_H = 52;

interface Bar { start: number; end: number | null; open: "ongoing" | "unknown" | null }
function barOf(t: ScheduleTask): Bar | null {
  const s = t.actual_start_date ?? t.planned_start_date;
  if (!s) return null;
  const e = t.status === "completed" ? (t.actual_end_date ?? t.planned_end_date) : t.planned_end_date;
  if (e) return { start: toDay(s), end: Math.max(toDay(e), toDay(s)), open: null };
  return { start: toDay(s), end: null, open: t.duration_type === "ongoing" ? "ongoing" : "unknown" };
}

const TONE: Record<string, string> = {
  completed: "done", in_progress: "doing", ready: "ready", not_started: "todo", waiting_dependency: "wait",
  waiting_third_party: "wait", waiting_client: "client", overdue: "late", cancelled: "cancel",
};

type Row =
  | { kind: "group"; track: ScheduleTrack; y: number; count: number; collapsed: boolean }
  | { kind: "task"; task: ScheduleTask; y: number; bar: Bar | null };

interface Change { task: ScheduleTask; start: string | null; duration: number | null }

/* ==========================================================================
   Gantt
   ========================================================================== */
export function GanttView({ schedule, staff, filters, me, editable, canManage, onOpen, onChanged }: {
  schedule: ProjectSchedule; staff: StaffMember[]; filters: ScheduleFilters; me: string | null;
  /** Modo gestão ligado e permissão de gestor. */
  editable: boolean; canManage: boolean;
  onOpen: (id: string) => void; onChanged: () => void;
}) {
  const today = todayISO();
  const todayN = toDay(today);
  const [scale, setScale] = useState<Scale>(() => {
    try { return (localStorage.getItem("yc-gantt-scale") as Scale) || "month"; } catch { return "month"; }
  });
  const changeScale = (s: Scale) => { setScale(s); try { localStorage.setItem("yc-gantt-scale", s); } catch { /* sem armazenamento */ } };
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; kind: "move" | "resize"; x0: number; delta: number; moved: boolean; locked: boolean } | null>(null);
  const [kbd, setKbd] = useState<{ id: string; kind: "move" | "resize"; delta: number } | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const dayW = DAY_W[scale];
  const staffById = useMemo(() => new Map(staff.map((m) => [m.id, m])), [staff]);

  // Linhas visíveis (filtros iguais às demais visões)
  const rows = useMemo(() => {
    const out: Row[] = [];
    let y = 0;
    const filtered = filters.quick !== "all" || !!filters.responsible || !!filters.step;
    for (const tr of sortTracks(schedule.tracks)) {
      if (filters.service && tr.id !== filters.service) continue;
      const tasks = schedule.tasks.filter((t) => t.schedule_track_id === tr.id && matchesFilters(t, filters, me, today))
        .sort((a, b) => a.sequence - b.sequence);
      if (filtered && tasks.length === 0) continue;
      const isCollapsed = collapsed.has(tr.id);
      out.push({ kind: "group", track: tr, y, count: tasks.length, collapsed: isCollapsed });
      y += GROUP_H;
      if (isCollapsed) continue;
      for (const t of tasks) { out.push({ kind: "task", task: t, y, bar: barOf(t) }); y += ROW_H; }
    }
    return { list: out, height: y };
  }, [schedule, filters, me, today, collapsed]);

  // Intervalo exibido: todas as etapas + hoje, com folga, alinhado ao início da semana/mês
  const range = useMemo(() => {
    let lo = todayN, hi = todayN;
    for (const t of schedule.tasks) {
      const b = barOf(t);
      if (!b) continue;
      lo = Math.min(lo, b.start); hi = Math.max(hi, b.end ?? b.start + 20);
    }
    for (const tr of schedule.tracks) {
      if (tr.planned_end_date) hi = Math.max(hi, toDay(tr.planned_end_date));
    }
    lo -= scale === "week" ? 7 : 14; hi += scale === "week" ? 14 : 45;
    if (scale === "week") lo -= (weekday(lo) + 6) % 7; // segunda-feira
    else { const d = new Date(lo * DAY); lo = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY; }
    return { lo, hi, days: hi - lo + 1 };
  }, [schedule, scale, todayN]);

  const x = (day: number) => (day - range.lo) * dayW;
  const width = range.days * dayW;

  // Rolagem inicial: hoje perto do começo da área visível
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, x(todayN) - (el.clientWidth - leftWidth(el)) * 0.25);
  }, [scale]); // eslint-disable-line react-hooks/exhaustive-deps

  const goToday = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: Math.max(0, x(todayN) - (el.clientWidth - leftWidth(el)) * 0.25), behavior: "smooth" });
  };

  // Cabeçalho em dois níveis
  const head = useMemo(() => buildHeader(range.lo, range.hi, scale), [range, scale]);

  // Dependências e destaque
  const pos = useMemo(() => {
    const m = new Map<string, { y: number; bar: Bar }>();
    rows.list.forEach((r) => { if (r.kind === "task" && r.bar) m.set(r.task.id, { y: r.y, bar: r.bar }); });
    return m;
  }, [rows]);
  const related = useMemo(() => {
    if (!selected) return null;
    const preds = new Set(schedule.dependencies.filter((d) => d.task_id === selected).map((d) => d.depends_on_task_id));
    const succs = new Set(schedule.dependencies.filter((d) => d.depends_on_task_id === selected).map((d) => d.task_id));
    return { preds, succs };
  }, [selected, schedule.dependencies]);

  const canMove = (t: ScheduleTask) => editable && !isStarted(t) && !isClosed(t) && !!t.planned_start_date;
  const canResize = (t: ScheduleTask) => editable && !isClosed(t) && (t.duration_type === "fixed" || t.duration_type === "external") && !!barOf(t)?.end;

  /* ---------- arrastar / redimensionar ---------- */
  function onPointerDown(e: RPointerEvent, t: ScheduleTask, kind: "move" | "resize") {
    if (e.button !== 0) return;
    if (kind === "resize" && !canResize(t)) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Sem permissão para mover: o clique só seleciona a etapa.
    setDrag({ id: t.id, kind, x0: e.clientX, delta: 0, moved: false, locked: kind === "move" && !canMove(t) });
  }
  function onPointerMove(e: RPointerEvent) {
    if (!drag || drag.locked) return;
    const dx = e.clientX - drag.x0;
    const delta = Math.round(dx / dayW);
    if (delta !== drag.delta || (!drag.moved && Math.abs(dx) > 3)) setDrag({ ...drag, delta, moved: drag.moved || Math.abs(dx) > 3 });
  }
  function onPointerUp(t: ScheduleTask) {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) { setSelected((s) => (s === t.id ? null : t.id)); return; }
    if (d.delta !== 0) proposeChange(t, d.kind, d.delta);
  }
  function proposeChange(t: ScheduleTask, kind: "move" | "resize", delta: number) {
    const b = barOf(t);
    if (!b) return;
    if (kind === "move") {
      setChange({ task: t, start: fromDay(b.start + delta), duration: null });
    } else {
      const newEnd = Math.max(b.start, (b.end ?? b.start) + delta);
      setChange({ task: t, start: null, duration: Math.max(1, businessDays(b.start, newEnd)) });
    }
  }
  function onBarKey(e: KeyboardEvent, t: ScheduleTask) {
    if (e.key === "Enter" && !kbd) { e.preventDefault(); onOpen(t.id); return; }
    if (e.key === " ") { e.preventDefault(); setSelected((s) => (s === t.id ? null : t.id)); return; }
    if (!editable) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const kind = e.shiftKey ? "resize" : "move";
      if ((kind === "move" && !canMove(t)) || (kind === "resize" && !canResize(t))) return;
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setKbd((k) => (k && k.id === t.id && k.kind === kind ? { ...k, delta: k.delta + step } : { id: t.id, kind, delta: step }));
    } else if (e.key === "Enter" && kbd?.id === t.id) {
      e.preventDefault();
      if (kbd.delta !== 0) proposeChange(t, kbd.kind, kbd.delta);
      setKbd(null);
    } else if (e.key === "Escape" && kbd) {
      e.preventDefault(); e.stopPropagation(); setKbd(null);
    }
  }

  const active = drag?.moved ? drag : kbd ? { ...kbd, moved: true } : null;

  if (schedule.tasks.length === 0) {
    return <Card><EmptyState icon="calendar" title="Sem etapas para exibir no Gantt." /></Card>;
  }

  return (
    <div className="gantt-wrap">
      <div className="gantt-tools">
        <Segmented<Scale> label="Escala do Gantt" value={scale} onChange={changeScale}
          options={[{ value: "week", label: "Semana" }, { value: "month", label: "Mês" }, { value: "quarter", label: "Trimestre" }]} />
        <Button variant="outline" size="sm" icon="calendar" onClick={goToday}>Hoje</Button>
        <span className="grow" />
        <span className="gantt-hint">
          {editable ? <><Icon name="grip" size={14} /> Arraste a barra para mudar o início; arraste a borda direita para mudar a duração. Nada muda sem a sua confirmação.</>
            : canManage ? "Ative o Modo gestão para ajustar prazos arrastando as barras."
            : "Clique numa etapa para destacar o que vem antes e depois dela."}
        </span>
      </div>

      <div className={cx("gantt", `gantt--${scale}`, selected && "has-selection")} ref={scroller}
        style={{ ["--day-w" as string]: `${dayW}px`, ["--row-h" as string]: `${ROW_H}px`, ["--group-h" as string]: `${GROUP_H}px` }}
        role="grid" aria-label="Gantt do cronograma" aria-rowcount={rows.list.length + 1}>
        <div className="gantt__inner" style={{ width: `calc(var(--gantt-left) + ${width}px)` }}>
          {/* Cabeçalho */}
          <div className="gantt__head" role="row" style={{ height: HEAD_H }}>
            <div className="gantt__corner" role="columnheader">
              <span>Etapa</span><span className="gantt__col-resp">Responsável</span><span className="gantt__col-status">Status</span>
            </div>
            <div className="gantt__scale" style={{ width }}>
              <div className="gantt__tier gantt__tier--top">
                {head.top.map((s) => <span key={s.from} style={{ left: x(s.from), width: (s.to - s.from + 1) * dayW }}>{s.label}</span>)}
              </div>
              <div className="gantt__tier gantt__tier--bottom">
                {head.bottom.map((s) => (
                  <span key={s.from} className={cx(s.weekend && "is-weekend", s.today && "is-today")}
                    style={{ left: x(s.from), width: (s.to - s.from + 1) * dayW }}>{s.label}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Corpo */}
          <div className="gantt__body" style={{ height: rows.height }}>
            <div className="gantt__canvas" aria-hidden="true" style={{
              left: "var(--gantt-left)", width, height: rows.height,
              backgroundPosition: `${-((weekday(range.lo) + 1) % 7) * dayW}px 0`,
            }}>
              <span className="gantt__today" style={{ left: x(todayN) + dayW / 2 }}><span>Hoje</span></span>
            </div>

            {rows.list.map((r) => r.kind === "group" ? (
              <div key={r.track.id} className="gantt__row gantt__row--group" role="row" style={{ top: r.y, height: GROUP_H }}>
                <div className="gantt__left" role="rowheader">
                  <button type="button" className="gantt__group" aria-expanded={!r.collapsed}
                    onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(r.track.id)) n.delete(r.track.id); else n.add(r.track.id); return n; })}>
                    <Icon name="chevronDown" size={14} className={cx("icon", r.collapsed && "is-collapsed")} />
                    <span className="truncate">{serviceName(r.track)}</span>
                    <span className="muted">· {plural(r.count, "etapa", "etapas")}</span>
                  </button>
                </div>
                <div className="gantt__lane" style={{ width }}>
                  {r.track.planned_start_date && (
                    <span className="gantt__summary" style={{
                      left: x(toDay(r.track.actual_start_date ?? r.track.planned_start_date)),
                      width: Math.max(dayW, ((r.track.planned_end_date ? toDay(r.track.planned_end_date) : range.hi) - toDay(r.track.actual_start_date ?? r.track.planned_start_date) + 1) * dayW),
                    }} />
                  )}
                </div>
              </div>
            ) : (
              <TaskRow key={r.task.id} row={r} x={x} dayW={dayW} hi={range.hi} today={today}
                responsible={r.task.responsible_user_id ? staffById.get(r.task.responsible_user_id)?.name ?? "Pessoa da equipe" : null}
                avatar={r.task.responsible_user_id ? staffById.get(r.task.responsible_user_id)?.avatar_url ?? null : null}
                selected={selected === r.task.id}
                relation={related ? (related.preds.has(r.task.id) ? "pred" : related.succs.has(r.task.id) ? "succ" : selected === r.task.id ? "self" : "none") : null}
                movable={canMove(r.task)} resizable={canResize(r.task)}
                ghost={active && active.id === r.task.id ? { kind: active.kind, delta: active.delta } : null}
                onOpen={() => onOpen(r.task.id)}
                onPointerDown={(e, kind) => onPointerDown(e, r.task, kind)} onPointerMove={onPointerMove} onPointerUp={() => onPointerUp(r.task)}
                onKey={(e) => onBarKey(e, r.task)} onBlur={() => { if (kbd?.id === r.task.id) setKbd(null); }} />
            ))}

            <Connectors schedule={schedule} pos={pos} x={x} dayW={dayW} width={width} height={rows.height} selected={selected} />
          </div>
        </div>
      </div>

      <div className="gantt-legend" aria-label="Legenda">
        {(["done", "doing", "todo", "client", "wait", "late"] as const).map((k) => (
          <span key={k}><i className={`gbar-swatch gbar--${k}`} />{LEGEND[k]}</span>
        ))}
        <span><i className="gbar-swatch gbar--open" />Prazo a definir / contínua</span>
        <span><i className="gdep-swatch" />Dependência</span>
      </div>

      {change && <ChangeModal change={change} onClose={() => setChange(null)} onDone={() => { setChange(null); onChanged(); }} />}
    </div>
  );
}

const LEGEND = { done: "Concluída", doing: "Em andamento", todo: "Não iniciada", client: "Aguardando cliente", wait: "Bloqueada", late: "Atrasada" };
const leftWidth = (el: HTMLElement) => parseFloat(getComputedStyle(el).getPropertyValue("--gantt-left")) || 0;

/* ---------- Linha de etapa ---------- */
function TaskRow({ row, x, dayW, hi, today, responsible, avatar, selected, relation, movable, resizable, ghost,
  onOpen, onPointerDown, onPointerMove, onPointerUp, onKey, onBlur }: {
  row: Extract<Row, { kind: "task" }>; x: (d: number) => number; dayW: number; hi: number; today: string;
  responsible: string | null; avatar: string | null; selected: boolean; relation: "pred" | "succ" | "self" | "none" | null;
  movable: boolean; resizable: boolean; ghost: { kind: "move" | "resize"; delta: number } | null;
  onOpen: () => void; onPointerDown: (e: RPointerEvent, kind: "move" | "resize") => void; onPointerMove: (e: RPointerEvent) => void;
  onPointerUp: () => void; onKey: (e: KeyboardEvent) => void; onBlur: () => void;
}) {
  const t = row.task;
  const st = displayStatus(t, today);
  const tone = TONE[st] ?? "todo";
  const b = row.bar;
  let barEl = null;
  if (b) {
    const end = b.end ?? (b.open === "ongoing" ? hi : b.start + 9);
    let s = b.start, e = end;
    if (ghost?.kind === "move") { s += ghost.delta; e += ghost.delta; }
    if (ghost?.kind === "resize") e = Math.max(s, e + ghost.delta);
    const left = x(s), w = Math.max(dayW, (e - s + 1) * dayW);
    const label = `${t.name}: ${formatDate(fromDay(b.start))}${b.end ? ` a ${formatDate(fromDay(b.end))}` : ""} · ${TASK_STATUS_LABEL[st]}`;
    barEl = (
      <>
        {ghost && (
          <span className="gbar gbar--origin" style={{ left: x(b.start), width: Math.max(dayW, (end - b.start + 1) * dayW) }} aria-hidden="true" />
        )}
        <span role="button" tabIndex={0} aria-label={label} aria-pressed={selected}
          className={cx("gbar", `gbar--${tone}`, b.end == null && "gbar--open", movable && "is-movable", ghost && "is-dragging", relation && `is-${relation}`)}
          style={{ left, width: w }} title={`${t.name}\n${b.end ? `${short(b.start)} – ${short(b.end)}` : short(b.start)} · ${durationText(t)}`}
          onPointerDown={(ev) => onPointerDown(ev, "move")} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onDoubleClick={onOpen} onKeyDown={onKey} onBlur={onBlur}>
          <span className="gbar__label">{w > 70 ? t.name : ""}</span>
          {resizable && (
            <span className="gbar__handle" aria-hidden="true"
              onPointerDown={(ev) => onPointerDown(ev, "resize")}
              onPointerMove={(ev) => { ev.stopPropagation(); onPointerMove(ev); }}
              onPointerUp={(ev) => { ev.stopPropagation(); onPointerUp(); }} />
          )}
        </span>
        {w <= 70 && <span className="gbar__outside" style={{ left: left + w + 6 }}>{t.name}</span>}
        {ghost && (
          <span className="gtip" style={{ left: left + w / 2 }}>
            {ghost.kind === "move"
              ? <>Início {short(s)}{b.end != null ? ` · término ${short(e)}` : ""}</>
              : <>{plural(businessDays(s, e), "dia útil", "dias úteis")} · término {short(e)}</>}
          </span>
        )}
      </>
    );
  }
  return (
    <div className={cx("gantt__row", relation && relation !== "none" && "is-related", relation === "none" && "is-dim")} role="row" style={{ top: row.y, height: ROW_H }}>
      <div className="gantt__left" role="rowheader">
        <button type="button" className="gantt__name" onClick={onOpen} title="Abrir detalhes da etapa">
          <span className="truncate">{t.name}</span>
        </button>
        <span className="gantt__col-resp">
          {responsible ? <><Avatar name={responsible} src={avatar} size="sm" /><span className="truncate">{responsible.split(" ")[0]}</span></>
            : <span className="text-warning">Sem resp.</span>}
        </span>
        <span className="gantt__col-status"><i className={`gdot gbar--${tone}`} aria-hidden="true" /><span className="truncate">{TASK_STATUS_LABEL[st]}</span></span>
      </div>
      <div className="gantt__lane" role="gridcell">
        {barEl ?? <span className="gantt__nodate">Datas a definir</span>}
      </div>
    </div>
  );
}

/* ---------- Conectores de dependência ---------- */
function Connectors({ schedule, pos, x, dayW, width, height, selected }: {
  schedule: ProjectSchedule; pos: Map<string, { y: number; bar: Bar }>; x: (d: number) => number; dayW: number;
  width: number; height: number; selected: string | null;
}) {
  const paths = schedule.dependencies.flatMap((d) => {
    const a = pos.get(d.depends_on_task_id), b = pos.get(d.task_id);
    if (!a || !b) return [];
    const ss = d.dependency_type === "start_to_start";
    const x1 = ss ? x(a.bar.start) : x((a.bar.end ?? a.bar.start)) + dayW;
    const y1 = a.y + ROW_H / 2;
    const x2 = x(b.bar.start);
    const y2 = b.y + ROW_H / 2;
    const gap = 8;
    let dpath: string;
    if (x2 - x1 >= gap * 2) {
      const mid = x1 + gap;
      dpath = `M${x1},${y1} H${mid} V${y2} H${x2 - 2}`;
    } else {
      const yMid = y2 > y1 ? b.y + 4 : b.y + ROW_H - 4;
      dpath = `M${x1},${y1} h${gap} V${yMid} H${x2 - gap} V${y2} H${x2 - 2}`;
    }
    const hot = selected && (d.task_id === selected || d.depends_on_task_id === selected);
    return [{ id: d.id, dpath, hot }];
  });
  return (
    <svg className="gantt__deps" width={width} height={height} aria-hidden="true">
      <defs>
        <marker id="garrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" /></marker>
        <marker id="garrow-hot" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" /></marker>
      </defs>
      {paths.filter((p) => !p.hot).map((p) => <path key={p.id} d={p.dpath} className="gdep" markerEnd="url(#garrow)" />)}
      {paths.filter((p) => p.hot).map((p) => <path key={p.id} d={p.dpath} className="gdep is-hot" markerEnd="url(#garrow-hot)" />)}
    </svg>
  );
}

/* ---------- Cabeçalho ---------- */
interface Seg { from: number; to: number; label: string; weekend?: boolean; today?: boolean }
function buildHeader(lo: number, hi: number, scale: Scale): { top: Seg[]; bottom: Seg[] } {
  const group = (key: (n: number) => string, label: (n: number) => string, extra?: (n: number) => Partial<Seg>) => {
    const out: Seg[] = [];
    for (let d = lo; d <= hi; d++) {
      const k = key(d);
      const last = out[out.length - 1];
      if (last && (last as Seg & { k?: string }).k === k) { last.to = d; continue; }
      out.push(Object.assign({ from: d, to: d, label: label(d), k }, extra?.(d)));
    }
    return out;
  };
  const ym = (n: number) => { const d = new Date(n * DAY); return `${d.getUTCFullYear()}-${d.getUTCMonth()}`; };
  const monthLabel = (n: number) => { const d = new Date(n * DAY); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const todayN = toDay(todayISO());
  if (scale === "week") {
    return {
      top: group(ym, monthLabel),
      bottom: group((n) => String(n), (n) => `${WEEKDAYS[weekday(n)]} ${new Date(n * DAY).getUTCDate()}`,
        (n) => ({ weekend: isWeekend(n), today: n === todayN })),
    };
  }
  if (scale === "month") {
    const monday = (n: number) => n - ((weekday(n) + 6) % 7);
    return {
      top: group(ym, monthLabel),
      bottom: group((n) => String(monday(n)), (n) => String(new Date(monday(n) * DAY).getUTCDate()).padStart(2, "0")),
    };
  }
  const q = (n: number) => { const d = new Date(n * DAY); return `${d.getUTCFullYear()}-${Math.floor(d.getUTCMonth() / 3)}`; };
  return {
    top: group(q, (n) => { const d = new Date(n * DAY); return `${Math.floor(d.getUTCMonth() / 3) + 1}º tri ${d.getUTCFullYear()}`; }),
    bottom: group(ym, (n) => MONTHS[new Date(n * DAY).getUTCMonth()]),
  };
}

/* ---------- Confirmação com impacto e motivo ---------- */
function ChangeModal({ change, onClose, onDone }: { change: Change; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.previewTaskChange(change.task.id, change.start, change.duration)
      .then((p) => { if (alive) setPreview(p); })
      .catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [change]);

  const what = change.start
    ? `Mover o início de “${change.task.name}” para ${formatDate(change.start, true)}`
    : `Alterar a duração de “${change.task.name}” para ${plural(change.duration ?? 0, "dia útil", "dias úteis")}`;

  async function confirm() {
    setBusy(true); setErr(null);
    try {
      const r = await api.rescheduleTask(change.task.id, change.start, change.duration, reason);
      toast(r.impacted_count ? `Prazo alterado. ${plural(r.impacted_count, "etapa recalculada", "etapas recalculadas")}.` : "Prazo alterado.");
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const unchanged = preview && preview.task.before_start === preview.task.after_start && preview.task.before_end === preview.task.after_end
    && preview.task.before_duration === preview.task.after_duration;

  return (
    <Modal open wide onClose={onClose} title="Confirmar alteração de prazo"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button loading={busy} disabled={!preview || !!unchanged || reason.trim().length < 3} onClick={confirm}>Confirmar alteração</Button>
      </>}>
      <p>{what}.</p>
      {err && <Alert tone="danger" title="Não foi possível aplicar">{err}</Alert>}
      {!preview && !err && <Skeleton height={96} />}
      {preview && (
        <>
          {unchanged && <Alert tone="info">As dependências desta etapa não permitem essa data: o cronograma ficaria igual. Escolha outra data.</Alert>}
          <ImpactPreview name={change.task.name} preview={preview} />
          <Field label="Motivo da alteração" required hint="Obrigatório. Fica no histórico com quem alterou e quando.">
            {({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} className="input textarea" rows={2} autoFocus
              value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: cliente pediu mais prazo para aprovar o estudo" />}
          </Field>
        </>
      )}
    </Modal>
  );
}
