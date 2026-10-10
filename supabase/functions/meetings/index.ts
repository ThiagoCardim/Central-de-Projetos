// Edge Function: reuniões com o cliente (horários, agendamento, Google Meet/Calendar/Drive).
//
// Permissões e regras ficam no banco (RPCs private.meeting_*). Aqui:
//   - com o JWT do usuário: slots, book, cancel, set_record, sync;
//   - sem login (link público, pelo token): link_info, link_book;
//   - com a service_role, só depois da validação: livre/ocupado, Meet, Calendar e Drive.
// verify_jwt = false por causa do link público.
import { AppError, corsHeaders, fromPostgrest, json, serviceClient, userClient } from "../_shared/http.ts";
import {
  accessToken, cancelEvent, createEvent, createSpace, freeBusy, googleAccount, GoogleError, moveFile, projectFolder,
  setSpaceRecording, shareWith, spaceArtifacts,
} from "../_shared/google.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(v: unknown, field: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new AppError(422, "invalid", `Campo inválido: ${field}.`);
  return v;
}
function token(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(v)) throw new AppError(404, "not_found", "Link de agendamento não encontrado.");
  return v;
}

// ---------------------------------------------------------------------------
// Livre/ocupado do Google Calendar (cache no banco por alguns minutos)
// ---------------------------------------------------------------------------
async function refreshBusy(hostId: string): Promise<void> {
  const db = serviceClient();
  const { data } = await db.rpc("meeting_busy_target", { p_host: hostId });
  const t = data as { email: string; from: string; to: string; fresh: boolean } | null;
  if (!t || t.fresh) return;
  const acc = await googleAccount();
  if (!acc) return;
  try {
    const tok = await accessToken(acc);
    const busy = await freeBusy(tok, t.email, t.from, t.to);
    await db.rpc("meeting_busy_put", { p_profile: hostId, p_from: t.from, p_to: t.to, p_intervals: busy });
  } catch (e) {
    console.error("freebusy", e);   // sem o Google, segue só com a disponibilidade do portal
  }
}

// ---------------------------------------------------------------------------
// Criação no Google: sala do Meet + evento na agenda (convites por e-mail)
// ---------------------------------------------------------------------------
function fmt(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" })
    .format(new Date(iso));
}

async function createInGoogle(meetingId: string): Promise<{ meet_uri: string | null; google_status: string }> {
  const db = serviceClient();
  const acc = await googleAccount();
  if (!acc) {
    await db.rpc("meeting_google_set", { p_meeting: meetingId, p: { google_status: "not_connected" } });
    return { meet_uri: null, google_status: "not_connected" };
  }
  const { data } = await db.rpc("meeting_google_payload", { p_meeting: meetingId });
  const m = data as {
    title: string; notes: string | null; starts_at: string; ends_at: string; record: boolean; attendees: { email: string; name?: string }[];
    host_name: string; project_name: string; kind_label: string;
  };
  try {
    const tok = await accessToken(acc);
    const { space, warning } = await createSpace(tok, m.record);
    const description = [
      `${m.kind_label} · ${m.project_name}`,
      `Com ${m.host_name}`,
      "",
      `Entrar na reunião: ${space.meetingUri}`,
      m.notes ? `\nPauta: ${m.notes}` : "",
      "",
      `A reunião é transcrita automaticamente${m.record ? " e gravada" : ""} para registrar o que foi alinhado. O link fica disponível no Portal YouCon.`,
    ].join("\n");
    let eventId: string | null = null;
    let eventError: string | null = null;
    try {
      eventId = await createEvent(tok, { title: m.title, description, startsAt: m.starts_at, endsAt: m.ends_at, location: space.meetingUri, attendees: m.attendees });
    } catch (e) {
      eventError = `A sala foi criada, mas o convite na agenda falhou: ${(e as Error).message}`;
    }
    await db.rpc("meeting_google_set", {
      p_meeting: meetingId,
      p: { meet_uri: space.meetingUri, meet_code: space.meetingCode, meet_space: space.name, calendar_event_id: eventId,
           google_status: "created", google_error: eventError ?? warning },
    });
    return { meet_uri: space.meetingUri, google_status: "created" };
  } catch (e) {
    const msg = e instanceof GoogleError ? e.message : "Falha ao falar com o Google.";
    await db.rpc("meeting_google_set", { p_meeting: meetingId, p: { google_status: "failed", google_error: msg } });
    return { meet_uri: null, google_status: "failed" };
  }
}

// ---------------------------------------------------------------------------
// Transcrição e gravação: busca no Meet, organiza no Drive e anexa à reunião
// ---------------------------------------------------------------------------
async function syncArtifacts(meetingId: string): Promise<string> {
  const db = serviceClient();
  const acc = await googleAccount();
  if (!acc) return "not_connected";
  const { data } = await db.rpc("meeting_google_payload", { p_meeting: meetingId });
  const m = data as { project_id: string; meet_space: string | null; record: boolean; share_with_client: boolean; client_emails: string[]; ends_at: string };
  if (!m?.meet_space) return "no_space";
  const tok = await accessToken(acc);
  const a = await spaceArtifacts(tok, m.meet_space);

  let transcriptUrl: string | null = null;
  let recordingUrl: string | null = null;
  const files: string[] = [];
  if (a.transcript?.docsDestination) {
    transcriptUrl = `https://docs.google.com/document/d/${a.transcript.docsDestination.document}/edit`;
    files.push(a.transcript.docsDestination.document);
  }
  if (a.recording?.driveDestination) {
    recordingUrl = a.recording.driveDestination.exportUri || `https://drive.google.com/file/d/${a.recording.driveDestination.file}/view`;
    files.push(a.recording.driveDestination.file);
  }
  if (files.length) {
    try {
      const folder = await projectFolder(tok, acc, m.project_id);
      for (const f of files) await moveFile(tok, f, folder);
      if (m.share_with_client) for (const f of files) for (const email of m.client_emails ?? []) await shareWith(tok, f, email);
    } catch (e) {
      console.error("drive", e);   // os links continuam válidos mesmo sem mover
    }
  }

  const hoursSinceEnd = (Date.now() - new Date(a.lastEnd ?? m.ends_at).getTime()) / 3600000;
  const complete = !!transcriptUrl && (!m.record || !!recordingUrl);
  const status = complete ? "done"
    : transcriptUrl || recordingUrl ? (a.pending || hoursSinceEnd < 24 ? "partial" : "done")
    : a.records.length === 0 ? (hoursSinceEnd > 48 ? "none" : "waiting")
    : (a.pending || hoursSinceEnd < 24 ? "waiting" : "none");
  await db.rpc("meeting_artifacts_put", { p_meeting: meetingId, p_transcript: transcriptUrl, p_recording: recordingUrl, p_status: status });
  return status;
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------
type Payload = Record<string, unknown> & { action?: string };

async function slots(req: Request, p: Payload) {
  const project = uuid(p.project_id, "projeto");
  const host = uuid(p.host_id, "pessoa");
  const user = userClient(req);
  const { error } = await user.rpc("meeting_slot_target", { p_project: project, p_host: host });
  if (error) throw fromPostgrest(error);
  await refreshBusy(host);
  const { data, error: e2 } = await user.rpc("meeting_slots_portal", { p_project: project, p_host: host, p_kind: p.kind });
  if (e2) throw fromPostgrest(e2);
  return data;
}

async function book(req: Request, p: Payload) {
  const project = uuid(p.project_id, "projeto");
  const host = uuid(p.host_id, "pessoa");
  const { data: id, error } = await userClient(req).rpc("meeting_book_portal", {
    p_project: project, p_host: host, p_kind: p.kind, p_starts: p.starts_at, p_task: p.task_id ?? null,
    p_notes: p.notes ?? null, p_record: !!p.record,
  });
  if (error) throw fromPostgrest(error);
  const g = await createInGoogle(id as string);
  return { id, ...g };
}

async function linkInfo(p: Payload) {
  const t = token(p.token);
  const db = serviceClient();
  const { data, error } = await db.rpc("meeting_link_info", { p_token: t });
  if (error) throw fromPostgrest(error);
  const info = data as { project_name: string; kind: string; kind_label: string; task_name: string | null; host: { name: string; avatar_url: string | null };
                         minutes: number; expires_at: string; host_id: string };
  await refreshBusy(info.host_id);
  const { data: s, error: e2 } = await db.rpc("meeting_link_slots", { p_token: t });
  if (e2) throw fromPostgrest(e2);
  return {
    project_name: info.project_name, kind: info.kind, kind_label: info.kind_label, task_name: info.task_name,
    host: info.host, minutes: info.minutes, expires_at: info.expires_at, slots: (s as { slots: string[] }).slots,
  };
}

async function linkBook(p: Payload) {
  const t = token(p.token);
  const db = serviceClient();
  const { data: id, error } = await db.rpc("meeting_link_book", {
    p_token: t, p_starts: p.starts_at, p_name: p.name ?? null, p_email: p.email ?? null, p_phone: p.phone ?? null, p_notes: p.notes ?? null,
  });
  if (error) throw fromPostgrest(error);
  const g = await createInGoogle(id as string);
  const { data } = await db.rpc("meeting_google_payload", { p_meeting: id });
  const m = data as { title: string; starts_at: string; ends_at: string; host_name: string };
  return { title: m.title, starts_at: m.starts_at, ends_at: m.ends_at, when: fmt(m.starts_at), host_name: m.host_name, ...g };
}

async function cancel(req: Request, p: Payload) {
  const id = uuid(p.meeting_id, "reunião");
  const { data, error } = await userClient(req).rpc("meeting_cancel", { p_meeting: id, p_reason: p.reason ?? null });
  if (error) throw fromPostgrest(error);
  const eventId = (data as { calendar_event_id: string | null }).calendar_event_id;
  if (eventId) {
    const acc = await googleAccount();
    if (acc) await cancelEvent(await accessToken(acc), eventId).catch((e) => console.error("cancel event", e));
  }
  return { cancelled: true };
}

async function setRecord(req: Request, p: Payload) {
  const id = uuid(p.meeting_id, "reunião");
  const { data, error } = await userClient(req).rpc("meeting_set_record", { p_meeting: id, p_record: !!p.record });
  if (error) throw fromPostgrest(error);
  const space = (data as { meet_space: string | null }).meet_space;
  if (space) {
    const acc = await googleAccount();
    if (acc) {
      try { await setSpaceRecording(await accessToken(acc), space, !!p.record); }
      catch (e) {
        throw new AppError(502, "google", `A preferência foi salva, mas o Meet não aceitou a mudança: ${(e as Error).message}. Use o botão de gravar na própria reunião.`);
      }
    }
  }
  return { record: !!p.record };
}

async function sync(req: Request, p: Payload) {
  const project = uuid(p.project_id, "projeto");
  const { data, error } = await userClient(req).rpc("meetings_to_sync", { p_project: project });
  if (error) throw fromPostgrest(error);
  const ids = (data as string[]) ?? [];
  const results: Record<string, string> = {};
  for (const id of ids.slice(0, 5)) {
    try { results[id] = await syncArtifacts(id); }
    catch (e) {
      console.error("sync", id, e);
      results[id] = "error";
      // marca a tentativa para não insistir a cada abertura da página
      await serviceClient().rpc("meeting_artifacts_put", { p_meeting: id, p_transcript: null, p_recording: null, p_status: null });
    }
  }
  return { checked: Object.keys(results).length, results };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });
  try {
    const p = (await req.json().catch(() => ({}))) as Payload;
    switch (p.action) {
      case "slots":      return json(req, 200, await slots(req, p));
      case "book":       return json(req, 200, await book(req, p));
      case "cancel":     return json(req, 200, await cancel(req, p));
      case "set_record": return json(req, 200, await setRecord(req, p));
      case "sync":       return json(req, 200, await sync(req, p));
      case "link_info":  return json(req, 200, await linkInfo(p));
      case "link_book":  return json(req, 200, await linkBook(p));
      default: throw new AppError(400, "bad_request", "Ação desconhecida.");
    }
  } catch (err) {
    if (err instanceof AppError) return json(req, err.status, { error: err.code, message: err.message });
    console.error("meetings", err);
    return json(req, 500, { error: "unexpected", message: "Erro inesperado. Tente novamente." });
  }
});
