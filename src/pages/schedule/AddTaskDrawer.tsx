import { EMPTY_REASON, ReasonField, reasonIsValid, reasonText, useChangeReasons } from "./ReasonField";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { useAuth } from "@/services/auth";
import { StepPicker } from "@/components/ui/StepPicker";
import { Alert, Button, Field, Input, Segmented, Select } from "@/components/ui/primitives";
import { Drawer, useToast } from "@/components/ui/overlays";
import type { ProjectSchedule, StaffMember, TaskLibraryItem } from "@/types/domain";
import { EMPLOYMENT_LABEL, plural } from "@/utils/format";
import { serviceName } from "./model";

type Kind = "fixed" | "external" | "ongoing";

/** "Ajustar este projeto": inclui uma etapa (da biblioteca ou nova) numa trilha, com responsável próprio. */
export function AddTaskDrawer({ trackId, schedule, staff, onClose, onSaved }: {
  trackId: string | null; schedule: ProjectSchedule; staff: StaffMember[]; onClose: () => void; onSaved: (taskId: string) => void;
}) {
  const toast = useToast();
  const { permissions } = useAuth();
  const library = useAsync(() => (trackId ? api.listTaskLibrary() : Promise.resolve([] as TaskLibraryItem[])), [trackId]);
  const track = schedule.tracks.find((t) => t.id === trackId);
  const tasks = useMemo(() => schedule.tasks.filter((t) => t.schedule_track_id === trackId).sort((a, b) => a.sequence - b.sequence), [schedule.tasks, trackId]);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<Kind>("fixed");
  const [duration, setDuration] = useState("");
  const [after, setAfter] = useState("");
  const [inSequence, setInSequence] = useState<"seq" | "par">("seq");
  const [responsible, setResponsible] = useState("");
  const [reason, setReason] = useState(EMPTY_REASON);
  const [reasons] = useChangeReasons("schedule");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!trackId) return;
    setName(""); setDescription(""); setKind("fixed"); setDuration(""); setResponsible(""); setReason(""); setErr(null); setInSequence("seq");
    setAfter(tasks.length ? tasks[tasks.length - 1].id : "");
  }, [trackId]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickStep(l: TaskLibraryItem) {
    setName(l.name);
    if (l.duration_type !== "dependent") setKind(l.duration_type as Kind);
    setDuration(l.default_duration_days ? String(l.default_duration_days) : "");
    if (l.description && !description) setDescription(l.description);
  }
  async function createStep(input: { name: string; duration_type: Kind; default_duration_days: number | null }) {
    const item = await api.createTaskLibraryItem({ ...input, created_by: permissions?.profile_id ?? null });
    library.setData([...(library.data ?? []), item]);
    return item;
  }

  if (!trackId || !track) return null;
  const afterTask = tasks.find((t) => t.id === after);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await api.addProjectTask({
        track_id: trackId!, after_id: after || null, name, description, duration: kind === "ongoing" || !duration ? null : Number(duration),
        duration_type: kind, responsible_id: responsible || null, in_sequence: inSequence === "seq", reason: reasonText(reason, reasons),
        save_to_library: false,
      });
      toast(r.impacted_count ? `Etapa incluída. ${plural(r.impacted_count, "etapa recalculada", "etapas recalculadas")}.` : "Etapa incluída.");
      onSaved(r.task_id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} title="Adicionar etapa" subtitle={`${serviceName(track)} · ajuste só deste projeto`}
      footer={<><span className="spacer" /><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button loading={busy} disabled={name.trim().length < 2 || !reasonIsValid(reason, reasons)} onClick={submit}>Incluir etapa</Button></>}>
      <div className="form">
        {err && <Alert tone="danger" title="Etapa não incluída">{err}</Alert>}
        <Field label="Etapa" required hint={permissions?.is_manager ? "Escolha da biblioteca. Se não estiver na lista, use “Adicionar nova etapa”." : "Escolha da biblioteca de etapas."}>
          {({ id }) => <StepPicker id={id} library={library.data ?? []} value={name} onPick={pickStep}
            onCreate={permissions?.is_manager ? createStep : undefined} />}
        </Field>
        <Field label="Descrição" hint="Opcional.">
          {({ id }) => <textarea id={id} className="input textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>

        <fieldset className="form__group">
          <legend className="label">Prazo</legend>
          <Segmented<Kind> label="Tipo de prazo" value={kind} onChange={setKind} options={[
            { value: "fixed", label: "Dias úteis" }, { value: "external", label: "Terceiros" }, { value: "ongoing", label: "Contínua" },
          ]} />
          {kind !== "ongoing" && (
            <Field label={kind === "external" ? "Estimativa (dias úteis)" : "Duração (dias úteis)"} hint="Em branco = prazo a definir.">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={1} max={2000} inputMode="numeric"
                value={duration} onChange={(e) => setDuration(e.target.value)} />}
            </Field>
          )}
        </fieldset>

        <fieldset className="form__group">
          <legend className="label">Posição</legend>
          <Field label="Começa depois de">
            {({ id }) => (
              <Select id={id} value={after} onChange={(e) => setAfter(e.target.value)}>
                <option value="">Início do serviço</option>
                {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            )}
          </Field>
          <Segmented<"seq" | "par"> label="Encaixe" value={inSequence} onChange={setInSequence} options={[
            { value: "seq", label: "Na sequência" }, { value: "par", label: "Em paralelo" },
          ]} />
          <p className="subtext">
            {inSequence === "seq"
              ? `As etapas que vinham ${afterTask ? `depois de “${afterTask.name}”` : "no início"} passam a esperar a nova.`
              : "Corre ao lado das demais, sem atrasar ninguém."}
          </p>
        </fieldset>

        <Field label="Responsável" hint="Pode ser alguém fora da equipe: a pessoa entra como colaborador indireto.">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} value={responsible} onChange={(e) => setResponsible(e.target.value)}>
              <option value="">Responsável direto do serviço</option>
              {staff.map((m) => <option key={m.id} value={m.id}>{m.name}{m.employment_type ? ` · ${EMPLOYMENT_LABEL[m.employment_type]}` : ""}</option>)}
            </Select>
          )}
        </Field>
        <ReasonField value={reason} onChange={setReason} reasons={reasons} label="Motivo" showVisibility={false}
          hint="Fica no histórico do cronograma." />
      </div>
    </Drawer>
  );
}
