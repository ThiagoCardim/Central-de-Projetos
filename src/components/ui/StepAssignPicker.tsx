import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/Icon";
import type { StepOption } from "@/types/domain";
import { cx } from "@/utils/format";
import { normName } from "./StepPicker";

export const stepKey = (o: Pick<StepOption, "project_service_id" | "task_code">) => `${o.project_service_id}|${o.task_code}`;

/**
 * Escolha de várias sub-etapas (agrupadas por serviço) para um colaborador indireto.
 * Etapas já com outra pessoa mostram quem é; marcar transfere para esta pessoa.
 */
export function StepAssignPicker({ options, selected, ownerOf, onChange, label, autoOpen }: {
  options: StepOption[];
  selected: string[];
  /** Quem (nome) responde hoje pela etapa, se for outra pessoa. */
  ownerOf: (key: string) => string | null;
  onChange: (keys: string[]) => void;
  label: string;
  autoOpen?: boolean;
}) {
  const auto = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(!!autoOpen);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxH: number } | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, { name: string; items: StepOption[] }>();
    options.filter((o) => !q || normName(o.task_name).includes(normName(q)) || normName(o.service_name).includes(normName(q)))
      .forEach((o) => {
        const g = m.get(o.project_service_id) ?? { name: o.service_name, items: [] };
        g.items.push(o); m.set(o.project_service_id, g);
      });
    return [...m.values()];
  }, [options, q]);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(Math.max(r.width, 320), window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    if (below >= 300 || below >= above) setPos({ left, width, top: r.bottom + 4, maxH: Math.min(440, below) });
    else setPos({ left, width, bottom: window.innerHeight - r.top + 4, maxH: Math.min(440, above) });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onScroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) place(); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", place); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = open && !!pos;
  useEffect(() => { if (shown) search.current?.focus(); }, [shown]);

  function close(focusButton = false) {
    setOpen(false); setPos(null); setQ("");
    if (focusButton) btn.current?.focus();
  }
  const toggle = (k: string) => onChange(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]);

  return (
    <>
      <button ref={btn} type="button" className="btn btn--outline btn--sm step-assign__btn" aria-haspopup="listbox" aria-expanded={open}
        aria-label={label} onClick={() => (open ? close() : setOpen(true))}>
        <Icon name="plus" size={14} /> {selected.length ? "Vincular mais etapas" : "Escolher etapas"}
      </button>
      {open && pos && createPortal(
        <div ref={pop} className="step-pop" style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.nativeEvent.stopPropagation(); close(true); } }}>
          <div className="step-pop__search">
            <Icon name="search" size={16} />
            <input ref={search} className="step-pop__input" placeholder="Buscar etapa ou serviço" value={q} onChange={(e) => setQ(e.target.value)}
              aria-label="Buscar etapa" aria-controls={`${auto}-list`} />
          </div>
          <div id={`${auto}-list`} role="listbox" aria-multiselectable="true" aria-label={label} className="step-pop__list">
            {groups.map((g) => (
              <div key={g.name} role="group" aria-label={g.name} className="step-pop__group">
                <span className="step-pop__glabel">{g.name}</span>
                {g.items.map((o) => {
                  const k = stepKey(o);
                  const on = selected.includes(k);
                  const owner = on ? null : ownerOf(k);
                  return (
                    <label key={k} className={cx("step-pop__opt step-pop__check", on && "is-selected")}>
                      <input type="checkbox" checked={on} onChange={() => toggle(k)} />
                      <span className="step-pop__name">{o.task_name}</span>
                      {owner && <span className="step-pop__hint">com {owner}</span>}
                    </label>
                  );
                })}
              </div>
            ))}
            {groups.length === 0 && <p className="step-pop__empty">{q ? `Nenhuma etapa com “${q}”.` : "Os serviços deste projeto ainda não têm etapas padrão."}</p>}
          </div>
          <div className="step-pop__done">
            <span className="subtext">{selected.length ? `${selected.length} ${selected.length === 1 ? "etapa marcada" : "etapas marcadas"}` : "Marque as etapas"}</span>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => close(true)}>Concluir</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
