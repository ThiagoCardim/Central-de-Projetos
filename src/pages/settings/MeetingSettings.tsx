import { useEffect, useState, type ChangeEvent } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { useSearchParam } from "@/lib/router";
import { Alert, Badge, Button, Card, Field, Input, LoadError, Segmented, Skeleton } from "@/components/ui/primitives";
import { ConfirmDialog, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { formatDateTime } from "@/utils/format";
import type { MeetingSettings } from "@/types/domain";

/* Configurações › Reuniões: regras da agenda da unidade e a conta Google central. */
const GOOGLE_RESULT: Record<string, { ok: boolean; text: string }> = {
  ok: { ok: true, text: "Conta Google conectada. As próximas reuniões já saem com a sala do Meet e a transcrição automática." },
  denied: { ok: false, text: "A conexão foi cancelada na tela do Google. Nada foi alterado." },
  expired: { ok: false, text: "O pedido de conexão expirou. Clique em Conectar de novo." },
  scopes: { ok: false, text: "Faltaram permissões: na tela do Google, marque todas as caixas (Agenda, Meet e Drive) e tente de novo." },
  error: { ok: false, text: "O Google não concluiu a conexão. Tente de novo; se continuar, confira as credenciais no Supabase." },
};

export function MeetingSettingsPanel({ tenantId }: { tenantId: string }) {
  const q = useAsync(() => api.meetingSettings(tenantId), [tenantId]);
  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (!q.data) return <Skeleton height={260} radius={16} />;
  return (
    <div className="settings__grid">
      <div className="stack">
        <GoogleCard s={q.data} onChanged={() => void q.reload()} />
        <RulesCard key={tenantId} s={q.data} tenantId={tenantId} onSaved={() => void q.reload()} />
      </div>
      <aside className="settings__help">
        <h3><Icon name="alertCircle" size={16} /> Como funciona</h3>
        <p>Cada pessoa da equipe define os próprios horários em <b>Agenda</b>. O cliente marca pelo portal, ou a equipe envia um link para ele escolher o horário sem login.</p>
        <p>A reunião é criada no Google Meet pela conta central da YouCon, com convite por e-mail para todos. A <b>transcrição</b> é automática; a <b>gravação</b> é opcional em cada reunião.</p>
        <p>Depois da reunião, a transcrição e a gravação vão para a pasta do projeto no Google Drive (“Portal YouCon · Reuniões”) e os links ficam no card de Reuniões do projeto. O Google leva de alguns minutos a algumas horas para gerar os arquivos.</p>
        <h3><Icon name="sliders" size={16} /> Para conectar</h3>
        <ol className="settings__steps">
          <li>No Google Cloud (da conta Workspace da YouCon), ative as APIs <b>Google Calendar</b>, <b>Google Meet REST</b> e <b>Google Drive</b>.</li>
          <li>Em “Tela de permissão OAuth”, escolha o tipo <b>Interno</b>.</li>
          <li>Crie um <b>ID do cliente OAuth</b> do tipo “Aplicativo da Web” com o URI de redirecionamento: <code>https://ewdgraxksonxtrylxpbd.supabase.co/functions/v1/google-oauth/callback</code></li>
          <li>No Supabase, em Edge Functions › Secrets, cadastre <code>GOOGLE_CLIENT_ID</code> e <code>GOOGLE_CLIENT_SECRET</code>.</li>
          <li>Clique em <b>Conectar</b> e entre com a conta central (ex.: reunioes@…). A transcrição exige o plano Business Standard ou superior.</li>
        </ol>
      </aside>
    </div>
  );
}

function GoogleCard({ s, onChanged }: { s: MeetingSettings; onChanged: () => void }) {
  const toast = useToast();
  const result = useSearchParam("google");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!result) return;
    setNotice(GOOGLE_RESULT[result] ?? GOOGLE_RESULT.error);
    const u = new URL(window.location.href);
    u.searchParams.delete("google");
    window.history.replaceState(null, "", u.pathname + u.search);
  }, [result]);
  const g = s.google;
  const status = g?.status ?? "disconnected";

  async function connect() {
    setBusy(true);
    try {
      const { url } = await api.googleConnect(`${window.location.origin}/configuracoes?aba=reunioes`);
      window.location.assign(url);
    } catch (e) { toast((e as Error).message, "error"); setBusy(false); }
  }
  async function disconnect() {
    setBusy(true);
    try { await api.googleDisconnect(); toast("Conta Google desconectada. As reuniões novas ficam sem sala do Meet automática."); setConfirm(false); onChanged(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }

  return (
    <Card title="Conta Google da YouCon" action={
      status === "connected" ? <Badge tone="success" dot>Conectada</Badge>
        : status === "error" ? <Badge tone="danger" dot>Precisa reconectar</Badge>
        : <Badge outline>Não conectada</Badge>}>
      <div className="stack">
        {notice && <Alert tone={notice.ok ? "info" : "danger"} title={notice.ok ? "Tudo certo" : "Não conectou"}>{notice.text}</Alert>}
        {status === "connected" && g ? (
          <p>As reuniões são criadas por <b>{g.email}</b>{g.connected_by ? <>, conectada por {g.connected_by}</> : null}{g.connected_at ? <> em {formatDateTime(g.connected_at)}</> : null}.</p>
        ) : status === "error" && g ? (
          <p className="text-danger">{g.last_error ?? "A conexão expirou ou foi revogada no Google."}</p>
        ) : (
          <p className="subtext">Sem a conta conectada, as reuniões são marcadas normalmente, mas sem sala do Meet, convite da agenda, transcrição nem gravação automáticas: a equipe informa o link à mão.</p>
        )}
        {s.can_connect ? (
          <div className="row">
            <Button icon={status === "connected" ? "refresh" : "link"} variant={status === "connected" ? "secondary" : "primary"} loading={busy && !confirm} onClick={connect}>
              {status === "connected" ? "Reconectar" : "Conectar conta Google"}
            </Button>
            {status !== "disconnected" && <Button variant="danger-ghost" onClick={() => setConfirm(true)}>Desconectar</Button>}
          </div>
        ) : <p className="subtext">Somente o ADM Global conecta a conta.</p>}
      </div>
      <ConfirmDialog open={confirm} danger loading={busy} title="Desconectar a conta Google?" confirmLabel="Desconectar"
        message="As reuniões já marcadas continuam no Google, mas as novas ficam sem sala do Meet, convite e transcrição automáticos até conectar de novo."
        onConfirm={disconnect} onCancel={() => setConfirm(false)} />
    </Card>
  );
}

type RulesForm = { alignment_minutes: string; presentation_minutes: string; min_notice_hours: string; horizon_days: string; buffer_minutes: string; slot_step_minutes: "15" | "30" | "60"; share_with_client: boolean };

function RulesCard({ s, tenantId, onSaved }: { s: MeetingSettings; tenantId: string; onSaved: () => void }) {
  const toast = useToast();
  const from = (x: MeetingSettings): RulesForm => ({
    alignment_minutes: String(x.alignment_minutes), presentation_minutes: String(x.presentation_minutes), min_notice_hours: String(x.min_notice_hours),
    horizon_days: String(x.horizon_days), buffer_minutes: String(x.buffer_minutes), slot_step_minutes: String(x.slot_step_minutes) as RulesForm["slot_step_minutes"],
    share_with_client: x.share_with_client,
  });
  const [v, setV] = useState<RulesForm>(() => from(s));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setV(from(s)); }, [s]);
  const n = {
    alignment_minutes: Number(v.alignment_minutes), presentation_minutes: Number(v.presentation_minutes), min_notice_hours: Number(v.min_notice_hours),
    horizon_days: Number(v.horizon_days), buffer_minutes: Number(v.buffer_minutes), slot_step_minutes: Number(v.slot_step_minutes), share_with_client: v.share_with_client,
  };
  const between = (x: number, a: number, b: number) => x >= a && x <= b;
  const errs = {
    alignment_minutes: between(n.alignment_minutes, 15, 240) ? null : "De 15 a 240 minutos.",
    presentation_minutes: between(n.presentation_minutes, 15, 240) ? null : "De 15 a 240 minutos.",
    min_notice_hours: v.min_notice_hours !== "" && between(n.min_notice_hours, 0, 336) ? null : "De 0 a 336 horas.",
    horizon_days: between(n.horizon_days, 1, 120) ? null : "De 1 a 120 dias.",
    buffer_minutes: v.buffer_minutes !== "" && between(n.buffer_minutes, 0, 120) ? null : "De 0 a 120 minutos.",
  };
  const invalid = Object.values(errs).some(Boolean);
  const changed = (Object.keys(n) as (keyof typeof n)[]).some((k) => n[k] !== s[k]);
  const num = (k: Exclude<keyof RulesForm, "share_with_client" | "slot_step_minutes">) => ({
    value: v[k], inputMode: "numeric" as const, onChange: (e: ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value.replace(/\D/g, "") }),
  });

  async function save() {
    setBusy(true);
    try { await api.meetingSettingsSave(tenantId, n); toast("Regras da agenda salvas. Valem para os próximos agendamentos."); onSaved(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }

  return (
    <Card title="Regras da agenda">
      <div className="csset mtgset">
        <Field label="Reunião de alinhamento" error={errs.alignment_minutes}>{({ id }) => <div className="csset__in"><Input id={id} {...num("alignment_minutes")} /><span>minutos</span></div>}</Field>
        <Field label="Apresentação de etapa" error={errs.presentation_minutes}>{({ id }) => <div className="csset__in"><Input id={id} {...num("presentation_minutes")} /><span>minutos</span></div>}</Field>
        <Field label="Antecedência mínima" hint="O cliente não marca em cima da hora. A equipe pode." error={errs.min_notice_hours}>
          {({ id }) => <div className="csset__in"><Input id={id} {...num("min_notice_hours")} /><span>horas</span></div>}</Field>
        <Field label="Até quantos dias à frente" error={errs.horizon_days}>{({ id }) => <div className="csset__in"><Input id={id} {...num("horizon_days")} /><span>dias</span></div>}</Field>
        <Field label="Intervalo entre reuniões" hint="Folga antes e depois de cada reunião da pessoa." error={errs.buffer_minutes}>
          {({ id }) => <div className="csset__in"><Input id={id} {...num("buffer_minutes")} /><span>minutos</span></div>}</Field>
        <div className="field">
          <span className="field__label">Horários de início a cada</span>
          <Segmented<RulesForm["slot_step_minutes"]> label="Horários de início a cada" value={v.slot_step_minutes} onChange={(x) => setV({ ...v, slot_step_minutes: x })}
            options={[{ value: "15", label: "15 min" }, { value: "30", label: "30 min" }, { value: "60", label: "1 hora" }]} />
        </div>
      </div>
      <label className="pset__check">
        <input type="checkbox" checked={v.share_with_client} onChange={(e) => setV({ ...v, share_with_client: e.target.checked })} />
        <span><b>Mostrar a transcrição e a gravação para o cliente</b><small>O cliente vê os links no portal e recebe acesso de leitura aos arquivos no Drive. Desmarcado, só a equipe vê.</small></span>
      </label>
      <div className="settings__save">
        <Button icon="check" loading={busy} disabled={!changed || invalid} onClick={save}>Salvar regras</Button>
      </div>
    </Card>
  );
}
