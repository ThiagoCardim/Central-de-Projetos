import { useState } from "react";
import { api } from "@/services/api";
import { useAsync, useDocumentTitle } from "@/hooks";
import { useParams } from "@/lib/router";
import { BrandMark } from "@/components/domain/Brand";
import { Avatar, Button, Input, Skeleton } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import type { PublicBookResult } from "@/types/domain";
import { minutesText, SlotPicker, whenText } from "./meetingsUi";

/* ==========================================================================
   Página pública /agendar/:token — o cliente escolhe o horário sem login.
   O link vale para uma reunião e expira (regras no banco).
   ========================================================================== */
export function PublicBookingPage() {
  useDocumentTitle("Agendar reunião");
  const { token = "" } = useParams();
  const q = useAsync(() => api.publicMeetingLink(token), [token]);
  const [slot, setSlot] = useState<string | null>(null);
  const [f, setF] = useState({ name: "", email: "", phone: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<PublicBookResult | null>(null);
  const d = q.data;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim());

  async function book() {
    if (!slot) return;
    setBusy(true); setErr(null);
    try {
      setDone(await api.publicMeetingBook({ token, starts_at: slot, name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim() || null, notes: f.notes.trim() || null }));
    } catch (e) {
      setErr((e as Error).message);
      setSlot(null);
      void q.reload();
    } finally { setBusy(false); }
  }

  return (
    <div className="auth pubbook">
      <main className="auth__panel pubbook__panel">
        <div className="auth__brand">
          <BrandMark className="auth__mark" />
          <span><strong>YouCon</strong><span className="muted">Portal de Projetos</span></span>
        </div>

        {q.error ? (
          <div className="auth__head">
            <h1>Link indisponível</h1>
            <p className="subtext">{q.error}</p>
          </div>
        ) : !d ? (
          <div className="stack"><Skeleton width={260} height={24} /><Skeleton height={140} radius={12} /></div>
        ) : done ? (
          <div className="stack pubbook__done">
            <span className="pubbook__ok" aria-hidden="true"><Icon name="checkCircle" size={28} /></span>
            <div className="auth__head">
              <h1>Reunião marcada</h1>
              <p className="subtext">{done.title}</p>
            </div>
            <p className="pubbook__when"><b>{done.when}</b> com {done.host_name}</p>
            <p className="subtext">{done.google_status === "created"
              ? "O convite com o link do Google Meet foi enviado para o seu e-mail. A reunião é transcrita automaticamente para registrar o que for combinado."
              : "A equipe envia o link da reunião para o seu e-mail."}</p>
            {done.meet_uri && <a className="btn btn--primary" href={done.meet_uri} target="_blank" rel="noreferrer"><Icon name="video" /> Link da reunião</a>}
          </div>
        ) : (
          <>
            <div className="auth__head">
              <h1>{d.task_name ? `${d.kind_label}: ${d.task_name}` : d.kind_label}</h1>
              <p className="subtext">{d.project_name}</p>
            </div>
            <div className="pubbook__host">
              <Avatar name={d.host.name} src={d.host.avatar_url} />
              <span><b>{d.host.name}</b><small className="subtext">Reunião on-line pelo Google Meet · {minutesText(d.minutes)}</small></span>
            </div>
            <div className="field">
              <span className="field__label">Escolha o horário</span>
              <SlotPicker slots={d.slots} value={slot} onChange={setSlot} />
            </div>
            {slot && (
              <div className="stack pubbook__form">
                <label className="field"><span className="field__label">Seu nome</span>
                  <Input value={f.name} maxLength={120} autoComplete="name" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
                <label className="field"><span className="field__label">E-mail</span>
                  <Input type="email" value={f.email} autoComplete="email" placeholder="nome@email.com" onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
                <label className="field"><span className="field__label">Telefone <small>(opcional)</small></span>
                  <Input value={f.phone} inputMode="tel" autoComplete="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
                <label className="field"><span className="field__label">Algo que queira tratar <small>(opcional)</small></span>
                  <textarea className="input textarea" rows={2} maxLength={2000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
                {err && <p className="dlvnote is-error"><Icon name="alertCircle" size={16} /><span>{err}</span></p>}
                <Button block size="lg" icon="check" loading={busy} disabled={f.name.trim().length < 2 || !emailOk} onClick={book}>Marcar {whenText(slot)}</Button>
              </div>
            )}
            {!slot && err && <p className="dlvnote is-error"><Icon name="alertCircle" size={16} /><span>{err}</span></p>}
          </>
        )}
      </main>
      <p className="auth__legal">Os seus dados são usados só para marcar a reunião e enviar o convite.</p>
    </div>
  );
}
