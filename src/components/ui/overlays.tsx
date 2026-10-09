// Drawer (desktop) / BottomSheet (mobile), Modal, ConfirmDialog e Toasts.
import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./primitives";
import { Icon } from "./Icon";
import { useIsMobile } from "@/hooks";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* Rolagem da página bloqueada enquanto houver qualquer diálogo aberto. Contador (e não
   "restaurar o valor anterior"): com diálogos aninhados que fecham juntos (confirmação dentro
   de uma gaveta), a ordem de limpeza deixava a página travada com overflow hidden. */
let scrollLocks = 0;
function lockScroll() {
  scrollLocks += 1;
  document.body.style.overflow = "hidden";
}
function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.body.style.overflow = "";
}

/** Foco preso no diálogo, Esc fecha, foco devolvido ao gatilho e rolagem da página bloqueada. */
function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();
    lockScroll();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== "Tab" || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const firstEl = items[0], lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      unlockScroll();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  return ref;
}

/** Detalhes sob demanda: drawer lateral no desktop, bottom sheet no mobile. */
export function Drawer({ open, onClose, title, subtitle, children, footer, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const mobile = useIsMobile();
  const ref = useDialog(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className={mobile ? "sheet" : wide ? "drawer drawer--wide" : "drawer"} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        {mobile && <div className="sheet__grip" aria-hidden="true" />}
        <header className="drawer__head">
          <div className="grow">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p className="subtext">{subtitle}</p>}
          </div>
          <Button variant="ghost" size="sm" iconOnly icon="x" onClick={onClose}>Fechar</Button>
        </header>
        <div className="drawer__body">{children}</div>
        {footer && <footer className="drawer__foot">{footer}</footer>}
      </div>
    </>,
    document.body,
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer: ReactNode; wide?: boolean;
}) {
  const ref = useDialog(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className={wide ? "modal modal--wide" : "modal"} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal__body">
          <h2 id={titleId}>{title}</h2>
          {children}
        </div>
        <div className="modal__foot">{footer}</div>
      </div>
    </>,
    document.body,
  );
}

/** Confirmação explícita para ações sensíveis (desativar, alterar status). */
export function ConfirmDialog({ open, title, message, confirmLabel, danger, loading, confirmDisabled, onConfirm, onCancel }: {
  open: boolean; title: string; message: ReactNode; confirmLabel: string; danger?: boolean; loading?: boolean;
  confirmDisabled?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} footer={
      <>
        <Button variant="ghost" onClick={onCancel} disabled={loading}>Cancelar</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading} disabled={confirmDisabled} data-autofocus>{confirmLabel}</Button>
      </>
    }>
      {typeof message === "string" ? <p>{message}</p> : <div className="confirm__msg">{message}</div>}
    </Modal>
  );
}

/* ---------- Toasts ---------- */
interface ToastItem { id: number; message: string; tone: "success" | "error" }
const ToastContext = createContext<((message: string, tone?: ToastItem["tone"]) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((message: string, tone: ToastItem["tone"] = "success") => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-2), { id, message, tone }]);
    window.setTimeout(() => dismiss(id), tone === "error" ? 7000 : 3500);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="region" aria-label="Notificações" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
            <Icon name={t.tone === "error" ? "alertCircle" : "checkCircle"} />
            <span className="toast__msg">{t.message}</span>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Dispensar"><Icon name="x" size={14} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast fora de <ToastProvider>");
  return ctx;
}
