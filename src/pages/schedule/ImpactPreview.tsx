import { Icon } from "@/components/ui/Icon";
import type { SchedulePreview } from "@/types/domain";
import { formatDate, plural } from "@/utils/format";

/** Antes → depois da etapa alterada, etapas impactadas e previsão de conclusão. */
export function ImpactPreview({ name, preview, limit = 8 }: { name: string; preview: SchedulePreview; limit?: number }) {
  return (
    <div className="impact">
      <p className="impact__head">
        <strong>{name}</strong>: {formatDate(preview.task.before_start)} – {formatDate(preview.task.before_end)}
        <Icon name="chevronRight" size={14} />
        <strong>{formatDate(preview.task.after_start)} – {formatDate(preview.task.after_end)}</strong>
      </p>
      {preview.task.before_duration !== preview.task.after_duration && preview.task.after_duration != null && (
        <p className="subtext">Duração: {preview.task.before_duration ?? "—"} → <strong>{plural(preview.task.after_duration, "dia útil", "dias úteis")}</strong></p>
      )}
      {preview.impacted_count === 0 ? (
        <p className="subtext">Nenhuma outra etapa muda.</p>
      ) : (
        <>
          <p className="impact__count">Esta alteração impactará {plural(preview.impacted_count, "etapa", "etapas")}.</p>
          <ul className="impact__list">
            {preview.impacted.slice(0, limit).map((i) => (
              <li key={i.id}>
                <span className="grow truncate">{i.name} <span className="muted">· {i.service}</span></span>
                <span className="num muted">{formatDate(i.before_end)}</span>
                <Icon name="chevronRight" size={12} />
                <span className="num">{formatDate(i.after_end)}</span>
              </li>
            ))}
            {preview.impacted.length > limit && <li className="muted">e mais {preview.impacted.length - limit}</li>}
          </ul>
        </>
      )}
      {preview.forecast_before !== preview.forecast_after && (
        <p className="subtext">Previsão de conclusão: {formatDate(preview.forecast_before, true)} → <strong>{formatDate(preview.forecast_after, true)}</strong></p>
      )}
    </div>
  );
}
