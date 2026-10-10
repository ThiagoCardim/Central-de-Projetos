// Integração com o Google (conta central da YouCon): Meet, Calendar e Drive.
//
// O refresh token fica no banco (schema private) e só é lido aqui, pela service_role.
// Variáveis de ambiente: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
import { serviceClient } from "./http.ts";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/drive",
];
export const TZ = "America/Sao_Paulo";

export class GoogleError extends Error {
  constructor(public status: number, message: string, public reason?: string) {
    super(message);
  }
}

interface Account { email: string; domain: string; refresh_token: string; root_folder_id: string | null; status: string }

let cached: { token: string; expires: number; email: string } | null = null;

export function googleConfigured(): boolean {
  return !!Deno.env.get("GOOGLE_CLIENT_ID") && !!Deno.env.get("GOOGLE_CLIENT_SECRET");
}

export function oauthRedirectUri(): string {
  return `${Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "")}/functions/v1/google-oauth/callback`;
}

/** Conta conectada (ou null quando não há conexão). */
export async function googleAccount(): Promise<Account | null> {
  if (!googleConfigured()) return null;
  const { data, error } = await serviceClient().rpc("google_account_get");
  if (error || !data) return null;
  return data as Account;
}

async function markAccount(status: string | null, error: string | null, rootFolder: string | null = null) {
  await serviceClient().rpc("google_account_mark", { p_status: status, p_error: error, p_root_folder: rootFolder });
}

/** Access token da conta central (renovado pelo refresh token). */
export async function accessToken(acc: Account): Promise<string> {
  if (cached && cached.email === acc.email && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: acc.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const msg = body.error === "invalid_grant"
      ? "A conexão com o Google expirou ou foi revogada. Conecte a conta de novo em Configurações › Reuniões."
      : `Google recusou a renovação do acesso (${body.error ?? res.status}).`;
    await markAccount("error", msg);
    throw new GoogleError(401, msg, body.error);
  }
  cached = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000, email: acc.email };
  return cached.token;
}

/** Chamada à API do Google com JSON. */
export async function gfetch<T = any>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body?.error;
    throw new GoogleError(res.status, e?.message ?? `Google respondeu ${res.status}`, e?.status ?? e?.errors?.[0]?.reason);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Meet
// ---------------------------------------------------------------------------
export interface Space { name: string; meetingUri: string; meetingCode: string }

/** Cria a sala do Meet: transcrição automática ligada; gravação automática conforme a reunião. */
export async function createSpace(token: string, record: boolean): Promise<{ space: Space; warning: string | null }> {
  const config = {
    accessType: "OPEN",
    entryPointAccess: "ALL",
    artifactConfig: {
      recordingConfig: { autoRecordingGeneration: record ? "ON" : "OFF" },
      transcriptionConfig: { autoTranscriptionGeneration: "ON" },
    },
  };
  try {
    const space = await gfetch<Space>(token, "https://meet.googleapis.com/v2/spaces", { method: "POST", body: JSON.stringify({ config }) });
    return { space, warning: null };
  } catch (e) {
    if (!(e instanceof GoogleError) || e.status !== 400) throw e;
    // Conta sem suporte à configuração automática: cria a sala e avisa para iniciar a transcrição na reunião.
    const space = await gfetch<Space>(token, "https://meet.googleapis.com/v2/spaces", {
      method: "POST", body: JSON.stringify({ config: { accessType: "OPEN", entryPointAccess: "ALL" } }),
    });
    return { space, warning: "O Google não aceitou ligar a transcrição automática nesta conta: inicie a transcrição ao abrir a reunião." };
  }
}

export async function setSpaceRecording(token: string, spaceName: string, record: boolean): Promise<void> {
  await gfetch(token, `https://meet.googleapis.com/v2/${spaceName}?updateMask=config.artifactConfig.recordingConfig.autoRecordingGeneration`, {
    method: "PATCH",
    body: JSON.stringify({ config: { artifactConfig: { recordingConfig: { autoRecordingGeneration: record ? "ON" : "OFF" } } } }),
  });
}

interface ConferenceRecord { name: string; startTime?: string; endTime?: string }
interface Transcript { name: string; state: string; docsDestination?: { document: string; exportUri: string } }
interface Recording { name: string; state: string; driveDestination?: { file: string; exportUri: string } }

/** Transcrições e gravações geradas para a sala. */
export async function spaceArtifacts(token: string, spaceName: string) {
  const filter = encodeURIComponent(`space.name="${spaceName}"`);
  const recs = await gfetch<{ conferenceRecords?: ConferenceRecord[] }>(token, `https://meet.googleapis.com/v2/conferenceRecords?filter=${filter}`);
  const records = recs.conferenceRecords ?? [];
  const transcripts: Transcript[] = [];
  const recordings: Recording[] = [];
  for (const r of records) {
    const t = await gfetch<{ transcripts?: Transcript[] }>(token, `https://meet.googleapis.com/v2/${r.name}/transcripts`);
    transcripts.push(...(t.transcripts ?? []));
    const g = await gfetch<{ recordings?: Recording[] }>(token, `https://meet.googleapis.com/v2/${r.name}/recordings`);
    recordings.push(...(g.recordings ?? []));
  }
  return {
    records,
    ended: records.length > 0 && records.every((r) => !!r.endTime),
    lastEnd: records.map((r) => r.endTime).filter(Boolean).sort().pop() ?? null,
    transcript: transcripts.find((t) => t.state === "FILE_GENERATED" && t.docsDestination) ?? null,
    recording: recordings.find((r) => r.state === "FILE_GENERATED" && r.driveDestination) ?? null,
    // Ainda processando (o Google leva de minutos a algumas horas para gerar os arquivos).
    pending: [...transcripts, ...recordings].some((x) => x.state !== "FILE_GENERATED"),
  };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
export interface EventInput {
  title: string; description: string; startsAt: string; endsAt: string; location: string;
  attendees: { email: string; name?: string }[];
}

export async function createEvent(token: string, ev: EventInput): Promise<string> {
  const body = {
    summary: ev.title,
    description: ev.description,
    location: ev.location,
    start: { dateTime: ev.startsAt, timeZone: TZ },
    end: { dateTime: ev.endsAt, timeZone: TZ },
    attendees: ev.attendees.map((a) => ({ email: a.email, displayName: a.name })),
    guestsCanInviteOthers: false,
    guestsCanModify: false,
    reminders: { useDefault: true },
  };
  const r = await gfetch<{ id: string }>(token, "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all", {
    method: "POST", body: JSON.stringify(body),
  });
  return r.id;
}

export async function cancelEvent(token: string, eventId: string): Promise<void> {
  try {
    await gfetch(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof GoogleError && (e.status === 404 || e.status === 410)) return;
    throw e;
  }
}

/** Ocupado na agenda de uma pessoa (em blocos de até 60 dias). */
export async function freeBusy(token: string, email: string, from: string, to: string): Promise<{ s: string; e: string }[]> {
  const out: { s: string; e: string }[] = [];
  let start = new Date(`${from}T00:00:00-03:00`);
  const end = new Date(`${to}T23:59:59-03:00`);
  while (start < end) {
    const stop = new Date(Math.min(end.getTime(), start.getTime() + 60 * 86400000));
    const r = await gfetch<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(
      token, "https://www.googleapis.com/calendar/v3/freeBusy",
      { method: "POST", body: JSON.stringify({ timeMin: start.toISOString(), timeMax: stop.toISOString(), timeZone: TZ, items: [{ id: email }] }) });
    const cal = r.calendars?.[email];
    if (cal?.errors?.length) return [];   // agenda não compartilhada: segue só com a disponibilidade do portal
    (cal?.busy ?? []).forEach((b) => out.push({ s: b.start, e: b.end }));
    start = stop;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------
async function createFolder(token: string, name: string, parent: string | null): Promise<string> {
  const r = await gfetch<{ id: string }>(token, "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parent ? { parents: [parent] } : {}) }),
  });
  return r.id;
}

/** Pasta raiz "Portal YouCon · Reuniões", compartilhada para leitura com o domínio da conta. */
export async function rootFolder(token: string, acc: Account): Promise<string> {
  if (acc.root_folder_id) return acc.root_folder_id;
  const id = await createFolder(token, "Portal YouCon · Reuniões", null);
  if (acc.domain && !["gmail.com", "googlemail.com"].includes(acc.domain)) {
    await gfetch(token, `https://www.googleapis.com/drive/v3/files/${id}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, {
      method: "POST", body: JSON.stringify({ type: "domain", role: "reader", domain: acc.domain }),
    }).catch(() => undefined);
  }
  await markAccount(null, null, id);
  acc.root_folder_id = id;
  return id;
}

/** Pasta do projeto (uma por projeto, dentro da raiz). */
export async function projectFolder(token: string, acc: Account, projectId: string): Promise<string> {
  const db = serviceClient();
  const { data } = await db.rpc("google_project_folder", { p_project: projectId, p_folder: null });
  const info = data as { folder_id: string | null; name: string } | null;
  if (info?.folder_id) return info.folder_id;
  const id = await createFolder(token, info?.name ?? "Projeto", await rootFolder(token, acc));
  await db.rpc("google_project_folder", { p_project: projectId, p_folder: id });
  return id;
}

/** Move o arquivo para a pasta (o Meet salva em "Meet Recordings"). */
export async function moveFile(token: string, fileId: string, folderId: string): Promise<void> {
  const f = await gfetch<{ parents?: string[] }>(token, `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents&supportsAllDrives=true`);
  if (f.parents?.includes(folderId)) return;
  const remove = (f.parents ?? []).join(",");
  await gfetch(token, `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${folderId}${remove ? `&removeParents=${remove}` : ""}&supportsAllDrives=true`, {
    method: "PATCH", body: "{}",
  });
}

export async function shareWith(token: string, fileId: string, email: string): Promise<void> {
  await gfetch(token, `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, {
    method: "POST", body: JSON.stringify({ type: "user", role: "reader", emailAddress: email }),
  }).catch(() => undefined);
}
