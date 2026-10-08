import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { Field, Select, Skeleton } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import type { ChangeReason, ReasonKind } from "@/types/domain";

export interface ReasonValue { reasonId: string; text: string }
export const EMPTY_REASON: ReasonValue = { reasonId: "", text: "" };

/** "Outro motivo" das listas que não têm um cadastrado (texto livre). */
const OTHER_ID = "__other";
const syntheticOther = (kind: ReasonKind): ChangeReason => ({
  id: OTHER_ID, label: "Outro motivo", description: null, client_visible: false, is_other: true, sort_order: 9999, active: true, kind,
});

export const REASON_KIND_LABEL: Record<ReasonKind, string> = {
  schedule: "Alteração de prazo",
  waiting_client: "Aguardando cliente",
  waiting_third_party: "Aguardando terceiro",
  waiting_dependency: "Impedimento",
  task_cancel: "Cancelamento de etapa",
  adjustment_reject: "Recusa de pedido de ajuste",
  intake_ignore: "Entrada ignorada (vendas)",
};

const cache = new Map<ReasonKind, Promise<ChangeReason[]>>();
/** Lista de motivos ativos de um uso (uma vez por sessão; `refresh` recarrega após edição). */
export function loadChangeReasons(refresh = false, kind: ReasonKind = "schedule"): Promise<ChangeReason[]> {
  if (refresh) { if (kind === "schedule") cache.clear(); else cache.delete(kind); }
  if (!cache.has(kind)) {
    cache.set(kind, api.listChangeReasons(false, kind)
      .then((list) => (list.some((r) => r.is_other) ? list : [...list, syntheticOther(kind)]))
      .catch((e) => { cache.delete(kind); throw e; }));
  }
  return cache.get(kind)!;
}

export function reasonIsValid(v: ReasonValue, reasons: ChangeReason[] | null): boolean {
  const r = reasons?.find((x) => x.id === v.reasonId);
  if (!r) return false;
  return !r.is_other || v.text.trim().length >= 3;
}

/** Texto final do motivo: rótulo (+ observação) ou o texto livre de "Outro motivo". */
export function reasonText(v: ReasonValue, reasons: ChangeReason[] | null): string {
  const r = reasons?.find((x) => x.id === v.reasonId);
  if (!r) return v.text.trim();
  if (r.is_other) return v.text.trim();
  return v.text.trim() ? `${r.label} · ${v.text.trim()}` : r.label;
}

/**
 * Motivo escolhido de uma lista padronizada.
 * "Outro motivo" libera o texto livre (obrigatório). Nos demais, uma observação é opcional.
 */
export function ReasonField({ value, onChange, reasons, autoFocus, label = "Motivo da alteração", showVisibility = true, hint }: {
  value: ReasonValue; onChange: (v: ReasonValue) => void; reasons: ChangeReason[] | null; autoFocus?: boolean; label?: string;
  /** Mostra se o cliente verá (só faz sentido para alterações de prazo). */
  showVisibility?: boolean;
  hint?: string;
}) {
  const selected = reasons?.find((r) => r.id === value.reasonId) ?? null;
  if (!reasons) return <Skeleton height={40} />;

  return (
    <div className="reason-field">
      <Field label={label} required hint={hint ?? "Fica no histórico com quem alterou e quando."}>
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} autoFocus={autoFocus} value={value.reasonId}
            onChange={(e) => onChange({ reasonId: e.target.value, text: "" })}>
            <option value="" disabled>Selecione o motivo</option>
            {reasons.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </Select>
        )}
      </Field>
      {selected && (
        selected.is_other ? (
          <Field label="Descreva o motivo" required>
            {({ id }) => <textarea id={id} className="input textarea" rows={2} autoFocus value={value.text}
              onChange={(e) => onChange({ ...value, text: e.target.value })} placeholder="Escreva o motivo" />}
          </Field>
        ) : (
          <Field label="Observação (opcional)">
            {({ id }) => <textarea id={id} className="input textarea" rows={2} value={value.text}
              onChange={(e) => onChange({ ...value, text: e.target.value })} placeholder="Detalhe, se ajudar a entender" />}
          </Field>
        )
      )}
      {showVisibility && selected && (
        <p className={selected.client_visible ? "reason-field__vis" : "reason-field__vis is-internal"}>
          <Icon name={selected.client_visible ? "eye" : "lock"} size={14} />
          {selected.client_visible
            ? "O cliente verá esta alteração com o motivo" + (selected.is_other || value.text.trim() ? " e o texto acima." : ".")
            : "Motivo interno: esta alteração não aparece para o cliente."}
        </p>
      )}
    </div>
  );
}

/** Carrega os motivos de um uso. */
export function useChangeReasons(kind: ReasonKind = "schedule"): [ChangeReason[] | null, string | null] {
  const [reasons, setReasons] = useState<ChangeReason[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setReasons(null);
    loadChangeReasons(false, kind).then((r) => { if (alive) setReasons(r); }).catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [kind]);
  return [reasons, err];
}
