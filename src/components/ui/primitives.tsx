// Componentes base: Button, Field, Input, Select, Segmented, Badge, StatusBadge,
// Card, MetricCard, Avatar, ProgressBar, Tabs, FilterBar, EmptyState, Skeleton, Alert.
import {
  forwardRef, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
} from "react";
import { Icon, type IconName } from "./Icon";
import { cx, initials, TASK_STATUS_LABEL, TASK_STATUS_TONE, type Tone } from "@/utils/format";
import type { TaskStatus } from "@/types/domain";

/* ---------- Button ---------- */
type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger" | "danger-ghost";
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconOnly?: boolean;
  loading?: boolean;
  block?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", icon, iconOnly, loading, block, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", `btn--${variant}`, size !== "md" && `btn--${size}`, iconOnly && "btn--icon", block && "btn--block", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {iconOnly ? <span className="sr-only">{children}</span> : children}
    </button>
  );
});

/* ---------- Field ---------- */
interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}
export function Field({ label, hint, error, required, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}{required && <span className="req" aria-hidden="true">*</span>}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint && !error && <span id={hintId} className="field__hint">{hint}</span>}
      {error && <span id={errorId} className="field__error" role="alert">{error}</span>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { large?: boolean }>(
  function Input({ className, large, ...rest }, ref) {
    return <input ref={ref} className={cx("input", large && "input--lg", className)} {...rest} />;
  },
);

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("select", className)} {...rest}>{children}</select>;
}

export function SearchInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="input-icon">
      <Icon name="search" />
      <Input type="search" {...props} />
    </div>
  );
}

/** Escolha exclusiva entre poucas opções (radiogroup acessível). */
export function Segmented<T extends string>({ value, options, onChange, label, id }: {
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  id?: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label} id={id}>
      {options.map((o) => (
        <button
          key={o.value} type="button" role="radio" aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const i = options.findIndex((x) => x.value === value);
            const next = options[(i + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length];
            onChange(next.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Badge ---------- */
export function Badge({ tone = "neutral", dot, tag, outline, children, title }: {
  tone?: Tone; dot?: boolean; tag?: boolean; outline?: boolean; children: ReactNode; title?: string;
}) {
  return (
    <span className={cx("badge", tone !== "neutral" && `badge--${tone}`, tag && "badge--tag", outline && "badge--outline")} title={title}>
      {dot && <span className="badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={TASK_STATUS_TONE[status]} dot>{TASK_STATUS_LABEL[status]}</Badge>;
}

/* ---------- Card ---------- */
export function Card({ title, count, action, flush, className, children, as: Tag = "section", ...rest }: {
  title?: ReactNode; count?: ReactNode; action?: ReactNode; flush?: boolean; className?: string; children: ReactNode;
  as?: "section" | "div" | "article"; "aria-label"?: string;
}) {
  return (
    <Tag className={cx("card", flush && "card--flush", className)} {...rest}>
      {(title || action) && (
        <header className="card__head">
          <div className="row">
            {title && <h2>{title}</h2>}
            {count != null && <span className="card__count num">{count}</span>}
          </div>
          {action}
        </header>
      )}
      {children}
    </Tag>
  );
}

/* ---------- MetricCard ---------- */
export function MetricCard({ label, value, hint, tone, onClick }: {
  label: string; value: ReactNode; hint?: ReactNode; tone?: "danger" | "warning" | "brand" | "quiet"; onClick?: () => void;
}) {
  const content = (
    <>
      <span className="label">{label}</span>
      <span className="metric__value">{value}</span>
      {hint && <span className="metric__hint">{hint}</span>}
    </>
  );
  const cls = cx("metric", tone && `metric--${tone}`);
  return onClick
    ? <button type="button" className={cls} onClick={onClick}>{content}</button>
    : <div className={cls}>{content}</div>;
}

/* ---------- Avatar ---------- */
export function Avatar({ name, src, size }: { name: string; src?: string | null; size?: "sm" | "lg" }) {
  return (
    <span className={cx("avatar", size && `avatar--${size}`)} aria-hidden="true">
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

/* ---------- ProgressBar ---------- */
export function ProgressBar({ value, label, tone, thin }: { value: number; label: string; tone?: "danger"; thin?: boolean }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={cx("progress", tone && `progress--${tone}`, thin && "progress--thin")}
      role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="progress__bar" style={{ width: `${v}%` }} />
    </div>
  );
}

/* ---------- Tabs ---------- */
/** Abas em uma linha. Quando não cabem, a faixa rola e mostra setas nas pontas; a aba ativa fica sempre visível. */
export function Tabs<T extends string>({ value, onChange, tabs, label }: {
  value: T; onChange: (v: T) => void; tabs: { value: T; label: string; count?: number }[]; label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setEdge({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    window.addEventListener("resize", update);
    return () => { el.removeEventListener("scroll", update); ro?.disconnect(); window.removeEventListener("resize", update); };
  }, [tabs.length]);

  // A aba ativa sempre à vista (inclusive quando vem pelo link ?aba=).
  useEffect(() => {
    const el = ref.current;
    const active = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !active) return;
    const pad = 32;
    if (active.offsetLeft < el.scrollLeft + pad) el.scrollTo({ left: Math.max(0, active.offsetLeft - pad), behavior: "smooth" });
    else if (active.offsetLeft + active.offsetWidth > el.scrollLeft + el.clientWidth - pad)
      el.scrollTo({ left: active.offsetLeft + active.offsetWidth - el.clientWidth + pad, behavior: "smooth" });
  }, [value]);

  const nudge = (dir: -1 | 1) => { const el = ref.current; if (el) el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.6), behavior: "smooth" }); };

  return (
    <div className={cx("tabs-wrap", edge.left && "has-left", edge.right && "has-right")}>
      {edge.left && (
        <button type="button" className="tabs__nav is-left" tabIndex={-1} aria-hidden="true" onClick={() => nudge(-1)}>
          <Icon name="chevronRight" size={16} />
        </button>
      )}
      <div ref={ref} className="tabs" role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button
            key={t.value} type="button" role="tab" className="tab" aria-selected={value === t.value}
            tabIndex={value === t.value ? 0 : -1}
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              const i = tabs.findIndex((x) => x.value === value);
              const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
              onChange(next.value);
              (e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[tabs.indexOf(next)])?.focus();
            }}
          >
            {t.label}
            {t.count != null && <span className="tab__count num">{t.count}</span>}
          </button>
        ))}
      </div>
      {edge.right && (
        <button type="button" className="tabs__nav is-right" tabIndex={-1} aria-hidden="true" onClick={() => nudge(1)}>
          <Icon name="chevronRight" size={16} />
        </button>
      )}
    </div>
  );
}

/* ---------- FilterBar ---------- */
export function FilterBar({ children, onClear, active }: { children: ReactNode; onClear?: () => void; active?: boolean }) {
  return (
    <div className="filterbar" role="search">
      {children}
      {onClear && active && (
        <Button variant="ghost" size="sm" icon="x" className="filterbar__clear" onClick={onClear}>Limpar filtros</Button>
      )}
    </div>
  );
}

/* ---------- EmptyState ---------- */
export function EmptyState({ icon = "checkCircle", title, text, action, compact }: {
  icon?: IconName; title: string; text?: ReactNode; action?: ReactNode; compact?: boolean;
}) {
  return (
    <div className={cx("empty", compact && "empty--compact")}>
      <span className="empty__icon"><Icon name={icon} /></span>
      <p className="empty__title">{title}</p>
      {text && <p className="empty__text">{text}</p>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

/* ---------- Skeleton ---------- */
export function Skeleton({ width = "100%", height = 12, radius, style }: {
  width?: number | string; height?: number | string; radius?: number; style?: CSSProperties;
}) {
  return <span className="skeleton" aria-hidden="true" style={{ width, height, borderRadius: radius, ...style }} />;
}

/* ---------- Alert (inline) ---------- */
export function Alert({ tone = "info", title, children, action }: {
  tone?: "info" | "danger" | "warning"; title?: string; children?: ReactNode; action?: ReactNode;
}) {
  const icon: IconName = tone === "danger" ? "alertCircle" : tone === "warning" ? "alert" : "alertCircle";
  return (
    <div className={cx("alert", `alert--${tone}`)} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={icon} />
      <div className="grow">
        {title && <strong>{title}</strong>}
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}

/** Estado de erro de carregamento com ação de tentar de novo. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert tone="danger" title="Não foi possível carregar" action={<Button variant="outline" size="sm" icon="refresh" onClick={onRetry}>Tentar de novo</Button>}>
      {message}
    </Alert>
  );
}
