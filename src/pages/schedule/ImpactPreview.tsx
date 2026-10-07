import { Icon } from "@/components/ui/Icon";
import type { SchedulePreview } from "@/types/domain";
import { formatDate, plural } from "@/utils/format";

type Item = SchedulePreview["impacted"][number];

/** Antes → depois da etapa alterada, etapas impactadas (deste serviço e dos demais do contrato) e previsão. */
export function ImpactPreview({ name, preview, limit = 8, reopen }: { name: string; preview: SchedulePreview; limit?: number; reopen?: boolean }) {
  const same = preview.impacted.filter((i) => i.same_service !== false);
  const others = preview.impacted.filter((i) => i.same_service === false);
  const byService = others.reduce<Record<string, Item[]>>((acc, i) => { (acc[i.service] ??= []).push(i); return acc; }, {});
  const delay = preview.delay_days ?? 0;

  return (
    <div className="impact">
      <p className="impact__head">
        <strong>{name}</strong>: {reopen ? "concluída em " : ""}{reopen ? formatDate(preview.task.before_end) : <>{formatDate(preview.task.before_start)} – {formatDate(preview.task.before_end)}</>}
        <Icon name="chevronRight" size={14} />
        <strong>{formatDate(preview.task.after_start)} – {formatDate(preview.task.after_end)}</strong>
      </p>
      {!reopen && preview.task.before_duration !== preview.task.after_duration && preview.task.after_duration != null && (
        <p className="subtext">Duração: {preview.task.before_duration ?? "—"} → <strong>{plural(preview.task.after_duration, "dia útil", "dias úteis")}</strong></p>
      )}
      {delay > 0 && (
        <p className="impact__delay">
          <Icon name="alert" size={14} />
          {reopen ? "Retrabalho" : "Atraso"} de {plural(delay, "dia útil", "dias úteis")}: as etapas à frente, em todos os serviços deste contrato, andam junto.
        </p>
      )}
      {preview.impacted_count === 0 ? (
        <p className="subtext">Nenhuma outra etapa muda.</p>
      ) : (
        <>
          <p className="impact__count">
            Esta alteração impactará {plural(preview.impacted_count, "etapa", "etapas")}
            {others.length > 0 ? ` em ${plural(Object.keys(byService).length + (same.length ? 1 : 0), "serviço", "serviços")}` : ""}.
          </p>
          {same.length > 0 && <ImpactGroup title="Neste serviço" items={same} limit={limit} />}
          {Object.entries(byService).map(([svc, items]) => (
            <ImpactGroup key={svc} title={svc} items={items} limit={Math.max(3, Math.floor(limit / 2))} other />
          ))}
        </>
      )}
      {preview.forecast_before !== preview.forecast_after && (
        <p className="subtext">Previsão de conclusão do contrato: {formatDate(preview.forecast_before, true)} → <strong>{formatDate(preview.forecast_after, true)}</strong></p>
      )}
    </div>
  );
}

function ImpactGroup({ title, items, limit, other }: { title: string; items: Item[]; limit: number; other?: boolean }) {
  return (
    <div className="impact__group">
      <p className="impact__group-title">{other ? <><span className="muted">Outro serviço do contrato ·</span> {title}</> : title}
        <span className="muted"> · {plural(items.length, "etapa", "etapas")}</span></p>
      <ul className="impact__list">
        {items.slice(0, limit).map((i) => (
          <li key={i.id}>
            <span className="grow truncate">{i.name}</span>
            {/* Sem término definido: mostra o início (o término segue "a definir"). */}
            <span className="num muted">{i.before_end || i.after_end ? formatDate(i.before_end) : `início ${formatDate(i.before_start)}`}</span>
            <Icon name="chevronRight" size={12} />
            <span className="num">{i.before_end || i.after_end ? formatDate(i.after_end) : formatDate(i.after_start)}</span>
          </li>
        ))}
        {items.length > limit && <li className="muted">e mais {items.length - limit}</li>}
      </ul>
    </div>
  );
}
