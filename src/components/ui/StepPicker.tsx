import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Input, Select } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import type { TaskLibraryItem } from "@/types/domain";
import { cx } from "@/utils/format";

type Kind = "fixed" | "external" | "ongoing";

/** Normaliza para comparar nomes: sem acento, minúsculo, espaços simples. */
export const normName = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
/** Raiz simples para achar nomes parecidos ("Alteração" x "Alterações"). */
const stem = (s: string) => normName(s).replace(/(coes|cao|oes|ao|es|s)$/u, "");

function suggestion(l: TaskLibraryItem) {
  if (l.duration_type === "external") return "Prazo de terceiros";
  if (l.duration_type === "ongoing") return "Contínua";
  if (l.duration_type === "dependent") return "Conforme outro serviço";
  return l.default_duration_days ? `${l.default_duration_days} d.u.` : "";
}

/**
 * Seletor de etapa da biblioteca. Só permite escolher etapas registradas;
 * quem pode registrar vê "Adicionar nova etapa" no fim da lista, que grava
 * na biblioteca e já seleciona a nova etapa (mantém os nomes padronizados).
 */
export function StepPicker({ library, value, onPick, onCreate, id, label = "Etapa", placeholder = "Selecione a etapa", invalid, className }: {
  library: TaskLibraryItem[];
  value: string;
  onPick: (item: TaskLibraryItem) => void;
  /** Ausente = sem permissão para registrar etapas. */
  onCreate?: (input: { name: string; duration_type: Kind; default_duration_days: number | null }) => Promise<TaskLibraryItem>;
  id?: string; label?: string; placeholder?: string; invalid?: boolean; className?: string;
}) {
  const auto = useId();
  const btnId = id ?? `${auto}-btn`;
  const listId = `${auto}-list`;
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<"pick" | "new">("pick");
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxH: number } | null>(null);
  // formulário "nova etapa"
  const [nName, setNName] = useState("");
  const [nKind, setNKind] = useState<Kind>("fixed");
  const [nDays, setNDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const items = useMemo(() => (q ? library.filter((l) => normName(l.name).includes(normName(q))) : library), [library, q]);
  const known = library.some((l) => normName(l.name) === normName(value));

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 300);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    if (below >= 280 || below >= above) setPos({ left, width, top: r.bottom + 4, maxH: Math.min(420, below) });
    else setPos({ left, width, bottom: window.innerHeight - r.top + 4, maxH: Math.min(420, above) });
  };
  useLayoutEffect(() => { if (open) place(); }, [open, mode]);
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
  useEffect(() => { if (shown && mode === "pick") search.current?.focus(); }, [shown, mode]);
  useEffect(() => { setActive(0); }, [q]);

  function close(focusButton = false) {
    setOpen(false); setPos(null); setMode("pick"); setQ(""); setErr(null);
    if (focusButton) btn.current?.focus();
  }
  function pick(l: TaskLibraryItem) { onPick(l); close(true); }
  function startNew() {
    setNName(q.trim()); setNKind("fixed"); setNDays(""); setErr(null); setMode("new");
  }

  const exact = library.find((l) => normName(l.name) === normName(nName));
  const similar = !exact && nName.trim().length >= 4 ? library.filter((l) => stem(l.name) === stem(nName) || normName(l.name).startsWith(normName(nName))).slice(0, 3) : [];

  async function create() {
    if (!onCreate || exact || nName.trim().length < 2) return;
    setBusy(true); setErr(null);
    try {
      const item = await onCreate({ name: nName.trim(), duration_type: nKind, default_duration_days: nKind === "fixed" && nDays ? Number(nDays) : null });
      pick(item);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  function onListKey(e: KeyboardEvent) {
    const total = items.length + (onCreate ? 1 : 0);
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(total - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (active < items.length) pick(items[active]); else if (onCreate) startNew(); }
    else if (e.key === "Escape") { e.preventDefault(); e.nativeEvent.stopPropagation(); close(true); }
  }
  useEffect(() => { pop.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  return (
    <>
      <button ref={btn} id={btnId} type="button" className={cx("select step-pick", !value && "is-empty", invalid && "is-invalid", className)}
        aria-haspopup="listbox" aria-expanded={open} aria-label={value ? `${label}: ${value}` : label}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}>
        <span className="step-pick__value">{value || placeholder}</span>
        {value && !known && <span className="step-pick__flag" title="Esta etapa não está na biblioteca">fora da biblioteca</span>}
      </button>
      {open && pos && createPortal(
        <div ref={pop} className="step-pop" style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.nativeEvent.stopPropagation(); close(true); } }}>
          {mode === "pick" ? (
            <>
              <div className="step-pop__search">
                <Icon name="search" size={16} />
                <input ref={search} className="step-pop__input" placeholder="Buscar etapa" value={q} onChange={(e) => setQ(e.target.value)}
                  onKeyDown={onListKey} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
                  aria-activedescendant={`${listId}-${active}`} aria-label="Buscar etapa da biblioteca" />
              </div>
              <ul id={listId} role="listbox" className="step-pop__list" aria-label="Etapas da biblioteca">
                {items.map((l, i) => (
                  <li key={l.id} id={`${listId}-${i}`} data-i={i} role="option" aria-selected={normName(l.name) === normName(value)}
                    className={cx("step-pop__opt", i === active && "is-active", normName(l.name) === normName(value) && "is-selected")}
                    onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(l)}>
                    <span className="step-pop__name">{l.name}</span>
                    <span className="step-pop__hint">{suggestion(l)}</span>
                    {normName(l.name) === normName(value) && <Icon name="check" size={16} />}
                  </li>
                ))}
                {items.length === 0 && <li className="step-pop__empty">{q ? `Nenhuma etapa com “${q}”.` : "A biblioteca está vazia."}</li>}
              </ul>
              {onCreate ? (
                <button type="button" data-i={items.length} id={`${listId}-${items.length}`}
                  className={cx("step-pop__new", active === items.length && "is-active")}
                  onMouseEnter={() => setActive(items.length)} onClick={startNew}>
                  <Icon name="plus" size={16} /> {q.trim() ? <>Adicionar “{q.trim()}” como nova etapa</> : "Adicionar nova etapa"}
                </button>
              ) : (
                <p className="step-pop__foot">Etapa que não está na lista? Peça a um gestor para registrá-la na biblioteca.</p>
              )}
            </>
          ) : (
            <form className="step-pop__form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
              <span className="step-pop__title">Nova etapa na biblioteca</span>
              <Input aria-label="Nome da nova etapa" autoFocus value={nName} onChange={(e) => setNName(e.target.value)} placeholder="Ex.: Vídeo 3D" />
              {exact && (
                <div className="step-pop__warn">
                  Já existe “{exact.name}”. <button type="button" className="link" onClick={() => pick(exact)}>Usar esta</button>
                </div>
              )}
              {similar.length > 0 && (
                <div className="step-pop__warn">
                  Parecida com: {similar.map((s, i) => (
                    <span key={s.id}>{i > 0 && ", "}<button type="button" className="link" onClick={() => pick(s)}>{s.name}</button></span>
                  ))}. Use uma delas para manter o padrão, ou continue se for outra etapa.
                </div>
              )}
              <div className="step-pop__row">
                <Select aria-label="Tipo de prazo" value={nKind} onChange={(e) => setNKind(e.target.value as Kind)}>
                  <option value="fixed">Dias úteis</option>
                  <option value="external">Prazo de terceiros</option>
                  <option value="ongoing">Contínua</option>
                </Select>
                {nKind === "fixed" && <Input aria-label="Prazo sugerido em dias úteis" type="number" min={1} max={2000} inputMode="numeric" placeholder="dias" value={nDays} onChange={(e) => setNDays(e.target.value)} />}
              </div>
              {err && <div className="step-pop__warn is-danger">{err}</div>}
              <div className="step-pop__actions">
                <Button type="button" variant="ghost" size="sm" onClick={() => setMode("pick")}>Voltar</Button>
                <Button type="submit" size="sm" loading={busy} disabled={!!exact || nName.trim().length < 2}>Adicionar e selecionar</Button>
              </div>
            </form>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
