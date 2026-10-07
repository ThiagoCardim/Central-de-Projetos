import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { Field, Select, Skeleton } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import type { ChangeReason } from "@/types/domain";

export interface ReasonValue { reasonId: string; text: string }
export const EMPTY_REASON: ReasonValue = { reasonId: "", text: "" };

let cache: Promise<ChangeReason[]> | null = null;
/** Lista de motivos ativos (carregada uma vez por sessão; `refresh` força recarga após edição). */
export function loadChangeReasons(refresh = false): Promise<ChangeReason[]> {
  if (!cache || refresh) cache = api.listChangeReasons().catch((e) => { cache = null; throw e; });
  return cache;
}

export function reasonIsValid(v: ReasonValue, reasons: ChangeReason[] | null): boolean {
  const r = reasons?.find((x) => x.id === v.reasonId);
  if (!r) return false;
  return !r.is_other || v.text.trim().length >= 3;
}

/**
 * Motivo da alteração de prazo: seleção de uma lista padronizada.
 * "Outro motivo" libera o texto livre (obrigatório). Nos demais, uma observação é opcional.
 */
export function ReasonField({ value, onChange, reasons, autoFocus }: {
  value: ReasonValue; onChange: (v: ReasonValue) => void; reasons: ChangeReason[] | null; autoFocus?: boolean;
}) {
  const selected = reasons?.find((r) => r.id === value.reasonId) ?? null;
  if (!reasons) return <Skeleton height={40} />;

  return (
    <div className="reason-field">
      <Field label="Motivo da alteração" required hint="Fica no histórico com quem alterou e quando.">
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
              onChange={(e) => onChange({ ...value, text: e.target.value })} placeholder="Ex.: terreno com restrição descoberta na visita técnica" />}
          </Field>
        ) : (
          <Field label="Observação (opcional)">
            {({ id }) => <textarea id={id} className="input textarea" rows={2} value={value.text}
              onChange={(e) => onChange({ ...value, text: e.target.value })} placeholder="Detalhe, se ajudar a entender a alteração" />}
          </Field>
        )
      )}
      {selected && (
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

/** Hook simples para carregar os motivos. */
export function useChangeReasons(): [ChangeReason[] | null, string | null] {
  const [reasons, setReasons] = useState<ChangeReason[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadChangeReasons().then((r) => { if (alive) setReasons(r); }).catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, []);
  return [reasons, err];
}
