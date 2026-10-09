import { useEffect, useState, type ChangeEvent } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Button, Card, Field, Input, LoadError, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";

/* Configurações › Customer Success: prazo de resposta da equipe por urgência. */
export function CsSettingsPanel({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const q = useAsync(() => api.csSettings(tenantId), [tenantId]);
  const [v, setV] = useState({ normal_days: "2", high_days: "1", urgent_hours: "4" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setV({ normal_days: String(q.data.normal_days), high_days: String(q.data.high_days), urgent_hours: String(q.data.urgent_hours) });
  }, [q.data]);

  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (q.loading && !q.data) return <Skeleton height={220} radius={16} />;
  const n = { normal_days: Number(v.normal_days), high_days: Number(v.high_days), urgent_hours: Number(v.urgent_hours) };
  const invalid = !(n.normal_days >= 1 && n.normal_days <= 30 && n.high_days >= 1 && n.high_days <= 30 && n.urgent_hours >= 1 && n.urgent_hours <= 72);
  const highTooLong = n.high_days > n.normal_days;
  const changed = q.data && (n.normal_days !== q.data.normal_days || n.high_days !== q.data.high_days || n.urgent_hours !== q.data.urgent_hours);

  async function save() {
    setBusy(true);
    try { await api.csSettingsSave(tenantId, n); toast("Prazos salvos. Valem para os próximos chamados."); await q.reload(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  const num = (k: keyof typeof v) => ({ value: v[k], inputMode: "numeric" as const, onChange: (e: ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value.replace(/\D/g, "") }) });

  return (
    <div className="settings__grid">
      <Card title="Prazo de resposta aos chamados do CS">
        <div className="csset">
          <Field label="Normal" hint="Dias úteis. Vence às 18h do último dia.">{({ id, describedBy }) => <div className="csset__in"><Input id={id} aria-describedby={describedBy} {...num("normal_days")} /><span>dias úteis</span></div>}</Field>
          <Field label="Alta" hint="Dias úteis. Vence às 18h do último dia." error={highTooLong ? "Não pode ser maior que o prazo Normal." : null}>
            {({ id, describedBy }) => <div className="csset__in"><Input id={id} aria-describedby={describedBy} {...num("high_days")} /><span>dias úteis</span></div>}
          </Field>
          <Field label="Urgente" hint="Horas corridas a partir da abertura.">{({ id, describedBy }) => <div className="csset__in"><Input id={id} aria-describedby={describedBy} {...num("urgent_hours")} /><span>horas</span></div>}</Field>
        </div>
        <div className="settings__save">
          <Button icon="check" loading={busy} disabled={!changed || invalid || highTooLong} onClick={save}>Salvar prazos</Button>
        </div>
      </Card>
      <aside className="settings__help">
        <h3><Icon name="alertCircle" size={16} /> Como funciona</h3>
        <p>O Customer Success abre chamados e alertas sobre um projeto. Eles vão para os <b>líderes do projeto</b>, com prazo de resposta pela urgência.</p>
        <p>O painel do CS mede o tempo da primeira resposta e quantos chamados foram respondidos dentro do prazo.</p>
        <p>Mudanças valem para os chamados abertos daqui em diante.</p>
      </aside>
    </div>
  );
}
