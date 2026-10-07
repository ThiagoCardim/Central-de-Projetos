import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { useNavigate } from "@/lib/router";
import { Alert, Badge, Button, Field, Input, LoadError, Select, Skeleton } from "@/components/ui/primitives";
import { Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import type { BoardCard, BoardColumn, ProjectListItem } from "@/types/domain";
import { CLIENT_TYPE_LABEL, cx, formatDate, plural, PROJECT_STATUS_LABEL, PROJECT_STATUS_TONE } from "@/utils/format";

/**
 * Quadro Kanban de projetos da unidade. As colunas organizam o trabalho da equipe
 * e não mudam o status do projeto (distribuição, equipe e cronograma seguem as regras deles).
 */
export function ProjectBoard({ projects, canEdit }: { projects: ProjectListItem[]; canEdit: boolean }) {
  const toast = useToast();
  const board = useAsync(() => api.loadBoard(), []);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [cards, setCards] = useState<BoardCard[]>([]);
  useEffect(() => { if (board.data) { setColumns(board.data.columns); setCards(board.data.cards); } }, [board.data]);

  const [dragCard, setDragCard] = useState<string | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [over, setOver] = useState<{ col: string; before: string | null } | null>(null);
  const [colOver, setColOver] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<BoardColumn | null>(null);

  // Projetos por coluna: sem posição (ou em coluna excluída) vão para a primeira coluna.
  const byColumn = useMemo(() => {
    const m = new Map<string, ProjectListItem[]>(columns.map((c) => [c.id, []]));
    if (!columns.length) return m;
    const pos = new Map(cards.map((c) => [c.project_id, c]));
    const order = (p: ProjectListItem) => pos.get(p.id)?.sort_order ?? Number.MAX_SAFE_INTEGER;
    for (const p of projects) {
      const col = pos.get(p.id)?.column_id;
      (m.get(col && m.has(col) ? col : columns[0].id) as ProjectListItem[]).push(p);
    }
    m.forEach((list) => list.sort((a, b) => order(a) - order(b) || (b.contracted_at ?? "").localeCompare(a.contracted_at ?? "")));
    return m;
  }, [projects, columns, cards]);

  /* ---------- mover card ---------- */
  async function moveCard(projectId: string, columnId: string, beforeId: string | null) {
    if (beforeId === projectId) return;
    const prev = cards;
    const list = (byColumn.get(columnId) ?? []).filter((p) => p.id !== projectId);
    const idx = beforeId ? list.findIndex((p) => p.id === beforeId) : list.length;
    const ord = (id: string) => cards.find((c) => c.project_id === id)?.sort_order ?? 0;
    const after = idx > 0 ? ord(list[idx - 1].id) : (beforeId ? ord(beforeId) - 20 : 0);
    const sort = beforeId ? (after + ord(beforeId)) / 2 : (list.length ? Math.max(...list.map((p) => ord(p.id))) : 0) + 10;
    setCards((cs) => [...cs.filter((c) => c.project_id !== projectId), { project_id: projectId, column_id: columnId, sort_order: sort }]);
    try { await api.boardMoveCard(projectId, columnId, beforeId); }
    catch (e) { setCards(prev); toast((e as Error).message, "error"); }
  }

  /* ---------- colunas ---------- */
  async function reorder(next: BoardColumn[]) {
    const prev = columns;
    setColumns(next);
    try { await api.boardReorderColumns(next.map((c) => c.id)); }
    catch (e) { setColumns(prev); toast((e as Error).message, "error"); }
  }
  const shift = (id: string, d: -1 | 1) => {
    const i = columns.findIndex((c) => c.id === id), j = i + d;
    if (j < 0 || j >= columns.length) return;
    const next = [...columns]; [next[i], next[j]] = [next[j], next[i]];
    void reorder(next);
  };
  async function rename(id: string, name: string) {
    const clean = name.trim();
    setRenaming(null);
    const col = columns.find((c) => c.id === id);
    if (!col || !clean || clean === col.name) return;
    const prev = columns;
    setColumns((cs) => cs.map((c) => (c.id === id ? { ...c, name: clean } : c)));
    try { await api.boardRenameColumn(id, clean); }
    catch (e) { setColumns(prev); toast((e as Error).message, "error"); }
  }
  async function add(name: string) {
    const clean = name.trim();
    if (!clean) { setAdding(false); return; }
    try {
      const id = await api.boardAddColumn(clean);
      setColumns((cs) => [...cs, { id, name: clean, sort_order: (cs[cs.length - 1]?.sort_order ?? 0) + 10 }]);
      setAdding(false);
      toast(`Coluna “${clean}” criada.`);
    } catch (e) { toast((e as Error).message, "error"); }
  }

  if (board.error) return <LoadError message={board.error} onRetry={board.reload} />;
  if (board.loading && !board.data) {
    return <div className="kanban">{[0, 1, 2].map((i) => <Skeleton key={i} width={300} height={360} radius={16} />)}</div>;
  }

  const onCardDragOver = (e: DragEvent, col: string, before: string | null) => {
    if (!dragCard) return;
    e.preventDefault(); e.stopPropagation();
    if (over?.col !== col || over.before !== before) setOver({ col, before });
  };

  return (
    <>
      {canEdit && (
        <p className="kanban-hint"><Icon name="grip" size={14} /> Arraste os cards entre as colunas e as colunas pelo título. As colunas organizam a equipe e não mudam o status do projeto.</p>
      )}
      <div className="kanban" role="list" aria-label="Quadro de projetos">
        {columns.map((col, ci) => {
          const list = byColumn.get(col.id) ?? [];
          return (
            <section key={col.id} role="listitem" aria-label={`${col.name}: ${plural(list.length, "projeto", "projetos")}`}
              className={cx("kcol", dragCol === col.id && "is-dragging", colOver === col.id && dragCol && dragCol !== col.id && "is-col-over",
                over?.col === col.id && over.before === null && "is-over")}
              onDragOver={(e) => {
                if (dragCol) { e.preventDefault(); setColOver(col.id); return; }
                onCardDragOver(e, col.id, null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragCol && dragCol !== col.id) {
                  const next = columns.filter((c) => c.id !== dragCol);
                  next.splice(next.findIndex((c) => c.id === col.id) + (columns.findIndex((c) => c.id === dragCol) < ci ? 1 : 0), 0, columns.find((c) => c.id === dragCol)!);
                  void reorder(next);
                } else if (dragCard && over) {
                  void moveCard(dragCard, over.col, over.before);
                }
                setDragCard(null); setDragCol(null); setOver(null); setColOver(null);
              }}>
              <header className="kcol__head" draggable={canEdit && renaming !== col.id}
                onDragStart={(e) => { if (!canEdit) return; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", col.id); setDragCol(col.id); }}
                onDragEnd={() => { setDragCol(null); setColOver(null); }}>
                {renaming === col.id ? (
                  <InlineName initial={col.name} label="Nome da coluna" onDone={(v) => rename(col.id, v)} onCancel={() => setRenaming(null)} />
                ) : (
                  <>
                    {canEdit && <span className="kcol__grip" aria-hidden="true"><Icon name="grip" size={14} /></span>}
                    <h2 className="kcol__title" onDoubleClick={() => canEdit && setRenaming(col.id)} title={canEdit ? "Clique duas vezes para renomear" : undefined}>{col.name}</h2>
                    <span className="kcol__count num">{list.length}</span>
                    {canEdit && (
                      <BoardMenu label={`Ações da coluna ${col.name}`} items={[
                        { label: "Renomear", icon: "edit", onClick: () => setRenaming(col.id) },
                        { label: "Mover para a esquerda", icon: "chevronRight", flip: true, disabled: ci === 0, onClick: () => shift(col.id, -1) },
                        { label: "Mover para a direita", icon: "chevronRight", disabled: ci === columns.length - 1, onClick: () => shift(col.id, 1) },
                        { label: "Excluir coluna", icon: "x", danger: true, disabled: columns.length <= 1, onClick: () => setDeleting(col) },
                      ]} />
                    )}
                  </>
                )}
              </header>
              <ul className="kcol__list">
                {list.map((p) => (
                  <li key={p.id} className={cx(over?.col === col.id && over.before === p.id && "is-over")}
                    onDragOver={(e) => onCardDragOver(e, col.id, p.id)}>
                    <BoardCardView project={p} canEdit={canEdit} dragging={dragCard === p.id}
                      columns={columns} currentColumn={col.id}
                      onMove={(target) => void moveCard(p.id, target, null)}
                      onDragStart={() => setDragCard(p.id)} onDragEnd={() => { setDragCard(null); setOver(null); }} />
                  </li>
                ))}
                {list.length === 0 && <li className="kcol__empty">{canEdit ? "Arraste projetos para cá" : "Nenhum projeto"}</li>}
              </ul>
            </section>
          );
        })}
        {canEdit && (
          <div className="kcol kcol--add">
            {adding ? (
              <InlineName initial="" label="Nome da nova coluna" placeholder="Ex.: Revisão com o cliente" onDone={add} onCancel={() => setAdding(false)} />
            ) : (
              <button type="button" className="kcol__addbtn" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Nova coluna</button>
            )}
          </div>
        )}
      </div>
      {deleting && (
        <DeleteColumnDialog column={deleting} columns={columns} count={(byColumn.get(deleting.id) ?? []).length}
          onClose={() => setDeleting(null)}
          onDeleted={(moveTo) => {
            setCards((cs) => cs.map((c) => (c.column_id === deleting.id ? { ...c, column_id: moveTo } : c)));
            setColumns((cs) => cs.filter((c) => c.id !== deleting.id));
            setDeleting(null);
          }} />
      )}
    </>
  );
}

/* ---------- Card ---------- */
function BoardCardView({ project: p, canEdit, dragging, columns, currentColumn, onMove, onDragStart, onDragEnd }: {
  project: ProjectListItem; canEdit: boolean; dragging: boolean; columns: BoardColumn[]; currentColumn: string;
  onMove: (column: string) => void; onDragStart: () => void; onDragEnd: () => void;
}) {
  const navigate = useNavigate();
  const open = () => navigate(`/projetos/${p.id}`);
  const services = p.services.filter((s) => s.active).map((s) => s.service?.name).filter(Boolean);
  return (
    <article className={cx("kcard", dragging && "is-dragging")} draggable={canEdit}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", p.id); onDragStart(); }}
      onDragEnd={onDragEnd}>
      <div className="kcard__top">
        <span className="kcard__code num">{p.code ?? "—"}</span>
        <span className="badge badge--tag badge--outline">{CLIENT_TYPE_LABEL[p.client_type]}</span>
        {canEdit && (
          <BoardMenu label={`Mover ${p.name}`} icon="more" items={columns.filter((c) => c.id !== currentColumn)
            .map((c) => ({ label: `Mover para “${c.name}”`, icon: "chevronRight" as const, onClick: () => onMove(c.id) }))} />
        )}
      </div>
      <button type="button" className="kcard__name" onClick={open}>{p.name}</button>
      <span className="kcard__client truncate">{p.client?.name ?? "—"}{p.city ? ` · ${p.city}${p.state ? `/${p.state}` : ""}` : ""}</span>
      {services.length > 0 && <span className="kcard__services">{services.join(" · ")}</span>}
      <div className="kcard__foot">
        <Badge tone={PROJECT_STATUS_TONE[p.status]} dot>{PROJECT_STATUS_LABEL[p.status]}</Badge>
        {p.services.some((s) => s.status === "pending_review" && s.active) && <Badge tone="warning">Serviço novo</Badge>}
      </div>
      <div className="kcard__meta">
        <span className="truncate"><Icon name="building" size={13} /> {p.delivery?.name ?? (p.delivery_tenant_id ? "Outra unidade" : "Sem unidade")}</span>
        <span className="num"><Icon name="calendar" size={13} /> {formatDate(p.contracted_at)}</span>
      </div>
    </article>
  );
}

/* ---------- Nome editável na própria coluna ---------- */
function InlineName({ initial, label, placeholder, onDone, onCancel }: {
  initial: string; label: string; placeholder?: string; onDone: (v: string) => void; onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (ok: boolean) => { if (done.current) return; done.current = true; if (ok) onDone(v); else onCancel(); };
  return (
    <Input className="kcol__input" aria-label={label} autoFocus value={v} maxLength={60} placeholder={placeholder}
      onChange={(e) => setV(e.target.value)} onBlur={() => finish(true)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      }} />
  );
}

/* ---------- Menu compacto ---------- */
type MenuItem = { label: string; icon: "edit" | "x" | "chevronRight" | "plus"; onClick: () => void; danger?: boolean; disabled?: boolean; flip?: boolean };
function BoardMenu({ label, items, icon = "more" }: { label: string; items: MenuItem[]; icon?: "more" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div className="menu kmenu" ref={ref}>
      <Button variant="ghost" size="sm" iconOnly icon={icon} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</Button>
      {open && (
        <div className="menu__list" role="menu">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" disabled={it.disabled} className={cx("menu__item", it.danger && "is-danger", it.flip && "flip")}
              onClick={() => { setOpen(false); it.onClick(); }}>
              <Icon name={it.icon} size={16} /> {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Exclusão segura de coluna ---------- */
function DeleteColumnDialog({ column, columns, count, onClose, onDeleted }: {
  column: BoardColumn; columns: BoardColumn[]; count: number; onClose: () => void; onDeleted: (moveTo: string) => void;
}) {
  const toast = useToast();
  const others = columns.filter((c) => c.id !== column.id);
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const match = typed.trim().toLowerCase() === column.name.trim().toLowerCase();
  return (
    <Modal open onClose={onClose} title={`Excluir a coluna “${column.name}”?`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="danger" disabled={!match || !moveTo} loading={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try {
            const r = await api.boardDeleteColumn(column.id, moveTo, typed);
            toast(r.moved ? `Coluna excluída. ${plural(r.moved, "projeto movido", "projetos movidos")}.` : "Coluna excluída.");
            onDeleted(moveTo);
          } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>Excluir coluna</Button>
      </>}>
      <ul className="del-facts">
        <li><Icon name="alert" size={16} /> A coluna sai do quadro de toda a unidade.</li>
        <li><Icon name="checkCircle" size={16} /> {count ? `${plural(count, "projeto será movido", "projetos serão movidos")} para a coluna escolhida abaixo. Nenhum projeto é excluído.` : "A coluna está vazia. Nenhum projeto é afetado."}</li>
        <li><Icon name="clock" size={16} /> O status dos projetos não muda e a exclusão fica registrada na auditoria.</li>
      </ul>
      {err && <Alert tone="danger">{err}</Alert>}
      {count > 0 && (
        <Field label="Mover os projetos para" required>
          {({ id }) => (
            <Select id={id} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
        </Field>
      )}
      <Field label={`Para confirmar, digite o nome da coluna: ${column.name}`}>
        {({ id }) => <Input id={id} value={typed} autoComplete="off" placeholder={column.name} onChange={(e) => setTyped(e.target.value)} />}
      </Field>
    </Modal>
  );
}
