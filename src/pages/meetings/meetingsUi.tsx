import { useEffect, useMemo, useState } from "react";
import { Button, Skeleton } from "@/components/ui/primitives";
import { cx, plural } from "@/utils/format";

/* ==========================================================================
   Utilitários das reuniões: datas no horário de Brasília e seletor de horários.
   ========================================================================== */
export const TZ = "America/Sao_Paulo";
const fParts = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const fTime = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const fWeekLong = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long" });
const fDayMonth = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });

const clean = (s: string) => s.replace(".", "");

/** "2026-10-16" no horário de Brasília. */
export const dayKey = (iso: string | Date) => fKey.format(new Date(iso));
export const timeOf = (iso: string) => fTime.format(new Date(iso));

export function dateParts(iso: string) {
  const p = Object.fromEntries(fParts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { weekday: clean(p.weekday ?? "").toUpperCase(), day: p.day ?? "", month: clean(p.month ?? "").toUpperCase() };
}

/** "hoje", "amanhã" ou "quinta-feira, 16/10". */
export function dayLabel(iso: string): string {
  const k = dayKey(iso);
  const today = dayKey(new Date());
  const tomorrow = dayKey(new Date(Date.now() + 86400000));
  if (k === today) return "hoje";
  if (k === tomorrow) return "amanhã";
  return `${fWeekLong.format(new Date(iso))}, ${fDayMonth.format(new Date(iso))}`;
}

/** "quinta-feira, 16/10 às 14:00" */
export const whenText = (iso: string) => `${dayLabel(iso)} às ${timeOf(iso)}`;

export function minutesText(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

/** Monta um instante no horário de Brasília (sem horário de verão desde 2019). */
export const brTime = (date: string, time: string) => new Date(`${date}T${time}:00-03:00`).toISOString();

/* ---------- Seletor de horários (dias + horas) ---------- */
export function SlotPicker({ slots, value, onChange, loading, error, onRetry }: {
  slots: string[] | null; value: string | null; onChange: (iso: string) => void; loading?: boolean; error?: string | null; onRetry?: () => void;
}) {
  const days = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of slots ?? []) {
      const k = dayKey(s);
      map.set(k, [...(map.get(k) ?? []), s]);
    }
    return [...map.entries()].map(([k, list]) => ({ key: k, first: list[0], list }));
  }, [slots]);
  const [day, setDay] = useState<string | null>(null);
  useEffect(() => {
    const valueDay = value ? dayKey(value) : null;
    if (valueDay && days.some((d) => d.key === valueDay)) setDay(valueDay);
    else if (!day || !days.some((d) => d.key === day)) setDay(days[0]?.key ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  if (error) {
    return (
      <div className="slots__empty">
        <p>{error}</p>
        {onRetry && <Button size="sm" variant="secondary" icon="refresh" onClick={onRetry}>Tentar de novo</Button>}
      </div>
    );
  }
  if (loading || !slots) {
    return <div className="slots"><Skeleton height={64} radius={12} /><Skeleton height={88} radius={12} /></div>;
  }
  if (days.length === 0) {
    return <div className="slots__empty"><p>Nenhum horário livre nos próximos dias. Escolha outra pessoa ou fale com a equipe.</p></div>;
  }
  const current = days.find((d) => d.key === day) ?? days[0];
  return (
    <div className="slots">
      <div className="slots__days" role="tablist" aria-label="Dia">
        {days.map((d) => {
          const p = dateParts(d.first);
          return (
            <button key={d.key} type="button" role="tab" aria-selected={d.key === current.key}
              className={cx("slots__day", d.key === current.key && "is-on", value && dayKey(value) === d.key && "has-pick")}
              onClick={() => setDay(d.key)}>
              <span className="slots__wd">{p.weekday}</span>
              <span className="slots__dd num">{p.day}</span>
              <span className="slots__mm">{p.month}</span>
              <span className="slots__n">{plural(d.list.length, "horário", "horários")}</span>
            </button>
          );
        })}
      </div>
      <div className="slots__times" role="radiogroup" aria-label={`Horários de ${dayLabel(current.first)}`}>
        {current.list.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={value === s}
            className={cx("slots__time num", value === s && "is-on")} onClick={() => onChange(s)}>
            {timeOf(s)}
          </button>
        ))}
      </div>
      <p className="subtext slots__tz">Horário de Brasília.</p>
    </div>
  );
}
