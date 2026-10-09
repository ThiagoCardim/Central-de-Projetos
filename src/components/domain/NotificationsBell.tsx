import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/services/api";
import { useNavigate } from "@/lib/router";
import { useAuth } from "@/services/auth";
import { Icon } from "@/components/ui/Icon";
import { Button, Skeleton } from "@/components/ui/primitives";
import type { AppNotification } from "@/types/domain";
import { cx, formatDateTime } from "@/utils/format";

function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) return `há ${Math.floor(s / 86400)} d`;
  return formatDateTime(iso);
}

/** Central de avisos: sino com contador e painel com os avisos recentes. */
export function NotificationsBell({ placement = "sidebar" }: { placement?: "sidebar" | "topbar" }) {
  const navigate = useNavigate();
  const isClient = useAuth().permissions?.role === "client";
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const load = () => api.myNotifications(30).then(setItems).catch(() => { /* sem avisos */ });
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!open) return;
    void load();
    const r = btn.current?.getBoundingClientRect();
    if (r) {
      const width = Math.min(380, window.innerWidth - 16);
      setPos(placement === "topbar"
        ? { top: r.bottom + 8, left: Math.max(8, window.innerWidth - width - 8) }
        : { top: Math.max(8, r.top), left: Math.min(r.right + 8, window.innerWidth - width - 8) });
    }
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const unread = (items ?? []).filter((n) => !n.read_at);
  async function markRead(ids: string[]) {
    setItems((xs) => (xs ?? []).map((n) => (ids.includes(n.id) ? { ...n, read_at: new Date().toISOString() } : n)));
    try { await api.markNotificationsRead(ids); } catch { /* tenta de novo na próxima carga */ }
  }
  function openItem(n: AppNotification) {
    if (!n.read_at) void markRead([n.id]);
    setOpen(false);
    if (n.kind === "adjustment_request" && n.entity_id) navigate(`/projetos/${n.entity_id}/cronograma?aba=ajustes`);
    else if (n.kind === "work_assigned") navigate("/minhas-tarefas");
    else if (n.kind === "approval_review" || n.kind === "approval_release") navigate("/aprovacoes");
    else if (n.kind.startsWith("cs_") && n.entity_id) navigate(`/cs?chamado=${n.entity_id}`);
    else if (n.kind === "nps_detractor") navigate("/cs?aba=nps");
    else if (n.kind === "support_opened") navigate("/cs?aba=atendimentos");
    else if (n.kind.startsWith("client_wait_") && typeof n.data?.project_id === "string")
      navigate(isClient ? (n.data.source === "delivery" ? `/entregas?projeto=${n.data.project_id}` : n.data.source === "documents" ? `/documentos?projeto=${n.data.project_id}` : "/")
        : n.data.source === "documents" ? `/projetos/${n.data.project_id}/documentos` : `/projetos/${n.data.project_id}`);
    else if (n.kind.startsWith("document_") && typeof n.data?.project_id === "string")
      navigate(isClient ? `/documentos?projeto=${n.data.project_id}` : `/projetos/${n.data.project_id}/documentos`);
    else if (n.kind.startsWith("delivery_") && typeof n.data?.project_id === "string")
      navigate(isClient ? `/entregas?projeto=${n.data.project_id}` : `/projetos/${n.data.project_id}/entregas`);
    else if (n.kind === "approval_rejected" && typeof n.data?.project_id === "string") navigate(`/projetos/${n.data.project_id}`);
    else if (n.entity_type === "projects" && n.entity_id) navigate(`/projetos/${n.entity_id}`);
    else if (n.entity_type === "project_tasks") navigate("/cronograma");
    else if (n.entity_type === "project_intakes") navigate("/entrada");
  }

  return (
    <>
      <button ref={btn} type="button" className={cx("bell", `bell--${placement}`)} aria-haspopup="dialog" aria-expanded={open}
        aria-label={unread.length ? `Avisos: ${unread.length} não lidos` : "Avisos"} title="Avisos" onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" size={18} />
        {unread.length > 0 && <span className="bell__count num">{unread.length > 9 ? "9+" : unread.length}</span>}
      </button>
      {open && pos && createPortal(
        <div ref={panel} className="npanel" role="dialog" aria-label="Avisos" style={{ top: pos.top, left: pos.left }}>
          <header className="npanel__head">
            <strong>Avisos</strong>
            {unread.length > 0 && <Button variant="ghost" size="sm" onClick={() => markRead(unread.map((n) => n.id))}>Marcar todos como lidos</Button>}
          </header>
          <div className="npanel__list">
            {!items ? <div className="stack" style={{ padding: 12 }}><Skeleton height={44} /><Skeleton height={44} /></div> :
             items.length === 0 ? <p className="npanel__empty">Nenhum aviso por aqui.</p> :
             items.map((n) => (
              <button key={n.id} type="button" className={cx("nitem", !n.read_at && "is-unread")} onClick={() => openItem(n)}>
                <span className={cx("nitem__icon", n.kind === "automation" && "is-auto")} aria-hidden="true">
                  <Icon name={n.kind === "automation" ? "zap" : n.kind === "adjustment_request" ? "refresh" : n.kind === "task_assigned" ? "user" : n.kind === "work_assigned" ? "checkCircle" : n.kind.startsWith("approval") ? "seal" : n.kind === "cs_alert" ? "alert" : n.kind === "nps_detractor" ? "trophy" : n.kind.startsWith("support_") ? "chat" : n.kind.startsWith("delivery_") ? "layers" : n.kind.startsWith("document_") ? "file" : n.kind.startsWith("client_wait_") ? "clock" : n.kind.startsWith("cs_") ? "headset" : n.kind.startsWith("project") ? "folder" : "bell"} size={16} />
                </span>
                <span className="nitem__text">
                  <span className="nitem__title">{n.title}</span>
                  {n.body && <span className="nitem__body">{n.body}</span>}
                  <span className="nitem__when">{n.kind === "automation" ? "Automação · " : ""}{timeAgo(n.created_at)}</span>
                </span>
                {!n.read_at && <span className="nitem__dot" aria-label="Não lido" />}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
