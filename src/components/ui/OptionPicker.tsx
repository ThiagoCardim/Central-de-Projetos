import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/utils/format";

export interface PickOption {
  value: string;
  label: string;
  /** Agrupa as opções na lista (ex.: família do serviço). */
  group?: string;
  /** Texto auxiliar à direita (ex.: "7 d.u."). */
  hint?: string;
  /** Termos extras para a busca (apelidos, siglas). */
  keywords?: string;
}

/** Normaliza para busca: sem acento, minúsculo. */
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

type Common = {
  options: PickOption[];
  id?: string;
  /** Rótulo acessível quando o campo não tem <label> visível. */
  label?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  loading?: boolean;
  className?: string;
  /** Rodapé da lista (ex.: "Adicionar novo"). Recebe o texto buscado. */
  footer?: (q: string, close: () => void) => ReactNode;
  emptyText?: string;
  /** Força a caixa de busca (padrão: só com mais de 7 opções). */
  searchable?: boolean;
};
type Single = Common & { multiple?: false; value: string; onChange: (v: string) => void; clearable?: boolean };
type Multi = Common & { multiple: true; value: string[]; onChange: (v: string[]) => void; max?: number };

/**
 * Seleção a partir de uma lista pré-definida, com busca.
 * - Uma opção (multiple ausente) ou várias (multiple) com marcação e chips.
 * - Abre com clique, Enter ou seta para baixo; navega com as setas; Esc fecha.
 */
export function OptionPicker(props: Single | Multi) {
  const { options, label, placeholder = "Selecione", searchPlaceholder = "Buscar", disabled, invalid, loading, className, footer, emptyText } = props;
  const multiple = props.multiple === true;
  const selected: string[] = multiple ? (props as Multi).value : (props as Single).value ? [(props as Single).value] : [];
  const auto = useId();
  const btnId = props.id ?? `${auto}-btn`;
  const listId = `${auto}-list`;
  const btn = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxH: number } | null>(null);

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const items = useMemo(() => {
    if (!q) return options;
    const n = norm(q);
    return options.filter((o) => norm(`${o.label} ${o.keywords ?? ""} ${o.group ?? ""}`).includes(n));
  }, [options, q]);
  const showSearch = props.searchable ?? options.length > 7;

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 280);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    if (below >= 260 || below >= above) setPos({ left, width, top: r.bottom + 4, maxH: Math.min(400, below) });
    else setPos({ left, width, bottom: window.innerHeight - r.top + 4, maxH: Math.min(400, above) });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
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
  useEffect(() => { if (shown) (showSearch ? search.current : pop.current)?.focus(); }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { pop.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  function close(focusButton = false) {
    setOpen(false); setPos(null); setQ("");
    if (focusButton) btn.current?.focus();
  }
  function toggle(v: string) {
    if (multiple) {
      const p = props as Multi;
      const has = p.value.includes(v);
      if (!has && p.max && p.value.length >= p.max) return;
      p.onChange(has ? p.value.filter((x) => x !== v) : [...p.value, v]);
    } else {
      (props as Single).onChange(v);
      close(true);
    }
  }
  function remove(v: string) {
    if (multiple) (props as Multi).onChange((props as Multi).value.filter((x) => x !== v));
    else (props as Single).onChange("");
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (items[active]) toggle(items[active].value); }
    else if (e.key === "Escape") { e.preventDefault(); e.nativeEvent.stopPropagation(); close(true); }
    else if (e.key === "Tab") close();
  }

  // Grupos na ordem em que aparecem
  const groups: { name: string | null; rows: { o: PickOption; i: number }[] }[] = [];
  items.forEach((o, i) => {
    const g = o.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.name === g) last.rows.push({ o, i }); else groups.push({ name: g, rows: [{ o, i }] });
  });

  const single = !multiple ? byValue.get(selected[0] ?? "") : null;
  const summary = multiple
    ? null
    : single?.label ?? ((props as Single).value || "");

  return (
    <>
      <div ref={btn} id={btnId} role="combobox" tabIndex={disabled ? -1 : 0} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        aria-label={label} aria-disabled={disabled || undefined}
        className={cx("select opick", selected.length === 0 && "is-empty", invalid && "is-invalid", disabled && "is-disabled", multiple && "opick--multi", className)}
        onClick={() => { if (!disabled) (open ? close() : setOpen(true)); }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) { e.preventDefault(); setOpen(true); }
          else if (open) onKey(e);
        }}>
        {multiple ? (
          selected.length === 0 ? <span className="opick__placeholder">{loading ? "Carregando…" : placeholder}</span> : (
            <span className="opick__chips">
              {selected.map((v) => (
                <span key={v} className="opick__chip">
                  {byValue.get(v)?.label ?? v}
                  {!disabled && (
                    <button type="button" className="opick__chip-x" aria-label={`Remover ${byValue.get(v)?.label ?? v}`}
                      onClick={(e) => { e.stopPropagation(); remove(v); }}><Icon name="x" size={12} /></button>
                  )}
                </span>
              ))}
            </span>
          )
        ) : (
          <span className={cx("opick__value", !summary && "opick__placeholder")}>{loading ? "Carregando…" : summary || placeholder}</span>
        )}
        {!multiple && (props as Single).clearable && selected.length > 0 && !disabled && (
          <button type="button" className="opick__clear" aria-label="Limpar" onClick={(e) => { e.stopPropagation(); remove(selected[0]); }}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      {open && pos && createPortal(
        <div ref={pop} className="step-pop opick-pop" tabIndex={-1} style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
          onKeyDown={onKey}>
          {showSearch && (
            <div className="step-pop__search">
              <Icon name="search" size={16} />
              <input ref={search} className="step-pop__input" placeholder={searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)}
                aria-controls={listId} aria-activedescendant={`${listId}-${active}`} aria-label={searchPlaceholder} />
            </div>
          )}
          <div id={listId} role="listbox" aria-multiselectable={multiple || undefined} className="step-pop__list" aria-label={label}>
            {groups.map((g, gi) => (
              <div key={`${g.name}-${gi}`} className="step-pop__group" role="group" aria-label={g.name ?? undefined}>
                {g.name && <span className="step-pop__glabel">{g.name}</span>}
                {g.rows.map(({ o, i }) => {
                  const on = selected.includes(o.value);
                  return (
                    <div key={o.value} id={`${listId}-${i}`} data-i={i} role="option" aria-selected={on}
                      className={cx("step-pop__opt", i === active && "is-active", on && "is-selected")}
                      onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(o.value)}>
                      {multiple && <span className={cx("opick__box", on && "is-on")} aria-hidden="true">{on && <Icon name="check" size={12} />}</span>}
                      <span className="step-pop__name">{o.label}</span>
                      {o.hint && <span className="step-pop__hint">{o.hint}</span>}
                      {!multiple && on && <Icon name="check" size={16} />}
                    </div>
                  );
                })}
              </div>
            ))}
            {items.length === 0 && <div className="step-pop__empty">{q ? `Nada encontrado para “${q}”.` : emptyText ?? "Nenhuma opção disponível."}</div>}
          </div>
          {multiple && selected.length > 0 && (
            <div className="opick-pop__foot">
              <span className="subtext">{selected.length === 1 ? "1 selecionado" : `${selected.length} selecionados`}</span>
              <button type="button" className="opick-pop__done" onClick={() => close(true)}>Concluir</button>
            </div>
          )}
          {footer?.(q, () => close(true))}
        </div>,
        document.body,
      )}
    </>
  );
}
