import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Badge, Button, Card, LoadError, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/utils/format";
import type { DeliverySettingsRow } from "@/types/domain";

/* Configurações › Entregas e revisões: regras por serviço (ADM Global edita). */
export function DeliverySettingsPanel() {
  const q = useAsync(() => api.deliverySettings(), []);
  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (!q.data) return <Skeleton height={360} radius={16} />;
  const { can_edit, services } = q.data;
  const families = [...new Set(services.map((s) => s.family))];

  return (
    <div className="settings__grid">
      <div className="stack">
        {families.map((fam) => (
          <Card key={fam} title={fam} flush>
            <ul className="dset">
              {services.filter((s) => s.family === fam).map((s) => <ServiceRule key={s.id} s={s} editable={can_edit} onSaved={() => void q.reload()} />)}
            </ul>
          </Card>
        ))}
      </div>
      <aside className="settings__help">
        <h3><Icon name="alertCircle" size={16} /> Como funciona</h3>
        <p>Cada serviço contratado tem a sua área de <b>Entregas</b>. Na fase de <b>criação</b> a equipe publica a apresentação preliminar e o cliente pode pedir revisões até o limite incluído.</p>
        <p>Quando o cliente aprova, o serviço segue para o <b>detalhamento</b> e o projeto final é publicado. Revisões além do limite só como <b>revisão adicional</b> (cortesia ou paga), liberada pelo líder da área.</p>
        <p>A <b>etapa de criação</b> indica quem é o responsável pela versão: as revisões contam para essa pessoa no indicador da Performance.</p>
        <p>Mudanças valem para os serviços que ainda não começaram as entregas.{!can_edit && " Somente o ADM Global altera estas regras."}</p>
      </aside>
    </div>
  );
}

function ServiceRule({ s, editable, onSaved }: { s: DeliverySettingsRow; editable: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ enabled: s.revisions_enabled, included: s.included_revisions, codes: s.creation_task_codes });
  const [busy, setBusy] = useState(false);
  useEffect(() => setV({ enabled: s.revisions_enabled, included: s.included_revisions, codes: s.creation_task_codes }), [s]);
  const dirty = v.enabled !== s.revisions_enabled || v.included !== s.included_revisions || v.codes.join() !== s.creation_task_codes.join();
  const toggleCode = (c: string) => setV((x) => ({ ...x, codes: x.codes.includes(c) ? x.codes.filter((y) => y !== c) : [...x.codes, c] }));

  async function save() {
    setBusy(true);
    try { await api.deliverySettingsSave(s.id, v.enabled, v.included, v.codes); toast(`Regras de ${s.name} salvas.`); onSaved(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  const names = s.task_options.filter((o) => v.codes.includes(o.code)).map((o) => o.name);

  return (
    <li className={cx("dset__row", !v.enabled && "is-off")}>
      <div className="dset__main">
        <b>{s.name}</b>
        <span className="subtext">
          {v.enabled ? `${v.included} ${v.included === 1 ? "revisão incluída" : "revisões incluídas"}` : "Sem rodadas de revisão (só a entrega)"}
          {v.enabled && (names.length ? ` · criação: ${names.join(", ")}` : " · etapa de criação não definida")}
        </span>
      </div>
      {editable ? (
        <div className="dset__edit">
          <label className="dset__toggle">
            <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Tem revisões
          </label>
          {v.enabled && (
            <span className="dset__count" role="group" aria-label={`Revisões incluídas em ${s.name}`}>
              <Button size="sm" variant="ghost" iconOnly icon="chevronDown" disabled={v.included <= 0} onClick={() => setV({ ...v, included: v.included - 1 })}>Menos</Button>
              <span className="num">{v.included}</span>
              <Button size="sm" variant="ghost" iconOnly icon="chevronDown" className="flip" disabled={v.included >= 20} onClick={() => setV({ ...v, included: v.included + 1 })}>Mais</Button>
            </span>
          )}
          {dirty && <Button size="sm" icon="check" loading={busy} onClick={save}>Salvar</Button>}
        </div>
      ) : <Badge>{v.enabled ? `${v.included} revisões` : "Sem revisões"}</Badge>}
      {editable && v.enabled && s.task_options.length > 0 && (
        <div className="dset__codes" role="group" aria-label="Etapas de criação">
          <span className="label">Etapa de criação</span>
          {s.task_options.map((o) => (
            <button key={o.code} type="button" className="chip" aria-pressed={v.codes.includes(o.code)} onClick={() => toggleCode(o.code)}>{o.name}</button>
          ))}
        </div>
      )}
    </li>
  );
}
