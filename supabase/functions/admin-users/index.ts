// Edge Function: gestão de usuários (convite, edição, ativação/desativação).
//
// Segurança em camadas:
//   1. A permissão é SEMPRE decidida pelo banco: chamamos as RPCs com o JWT do
//      administrador (RLS + funções private.can_*).
//   2. Só depois usamos a service_role para o que o banco não faz: enviar o
//      convite pelo Supabase Auth, vincular o auth_user_id e encerrar sessões.
import { AppError, corsHeaders, fromPostgrest, json, serviceClient, userClient } from "../_shared/http.ts";

type Role = "client" | "collaborator" | "leader" | "unit_admin" | "global_admin";

interface InvitePayload {
  action: "invite";
  tenant_id: string;
  name: string;
  email: string;
  role: Role;
  employment_type?: "clt" | "pj" | null;
  client_type?: "b2c" | "b2b" | null;
  client_id?: string | null;
  phone?: string | null;
}
interface UpdatePayload {
  action: "update";
  profile_id: string;
  name: string;
  role: Role;
  employment_type?: "clt" | "pj" | null;
  client_type?: "b2c" | "b2b" | null;
  phone?: string | null;
  tenant_id?: string | null;
}
interface StatusPayload {
  action: "set_status";
  profile_id: string;
  status: "ativo" | "inativo";
}
interface ResendPayload {
  action: "resend_invite";
  profile_id: string;
}
type Payload = InvitePayload | UpdatePayload | StatusPayload | ResendPayload;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: Role[] = ["client", "collaborator", "leader", "unit_admin", "global_admin"];

function assertUuid(v: unknown, field: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new AppError(422, "invalid", `Campo inválido: ${field}.`);
  return v;
}

/**
 * Destino do link de convite. APP_URL tem prioridade; sem ela, usa a origem do
 * app que chamou — somente se estiver em APP_ALLOWED_ORIGINS (quando definida).
 * O Supabase Auth ainda valida o destino contra a lista de Redirect URLs.
 */
function redirectUrl(req: Request): string {
  const configured = Deno.env.get("APP_URL");
  const origin = req.headers.get("origin") ?? "";
  const allowed = (Deno.env.get("APP_ALLOWED_ORIGINS") ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  const base = configured || (allowed.length === 0 || allowed.includes(origin) ? origin : allowed[0]);
  return `${base.replace(/\/$/, "")}/definir-senha`;
}

/** Envia o convite do Supabase Auth e vincula o usuário criado ao perfil. */
async function sendInvite(req: Request, profileId: string, email: string, name: string): Promise<boolean> {
  const admin = serviceClient();
  const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(email.trim().toLowerCase(), {
    redirectTo: redirectUrl(req),
    data: { name: name.trim() },
  });
  if (error || !invited?.user) return false;
  const { error: linkError } = await admin.rpc("admin_link_auth_user", {
    p_profile_id: profileId,
    p_auth_user_id: invited.user.id,
  });
  if (linkError) throw fromPostgrest(linkError);
  return true;
}

async function invite(req: Request, p: InvitePayload) {
  assertUuid(p.tenant_id, "unidade");
  if (!p.name || p.name.trim().length < 2) throw new AppError(422, "invalid", "Informe o nome completo.");
  if (!EMAIL_RE.test(p.email ?? "")) throw new AppError(422, "invalid", "Informe um e-mail válido.");
  if (!ROLES.includes(p.role)) throw new AppError(422, "invalid", "Perfil de acesso inválido.");

  // 1) Banco valida permissão e cria o perfil pendente.
  const user = userClient(req);
  const { data: profileId, error } = await user.rpc("admin_prepare_user", {
    p_tenant_id: p.tenant_id,
    p_name: p.name,
    p_email: p.email,
    p_role: p.role,
    p_employment_type: p.employment_type ?? null,
    p_client_type: p.client_type ?? null,
    p_client_id: p.client_id ?? null,
    p_phone: p.phone ?? null,
  });
  if (error) throw fromPostgrest(error);

  // 2) Convite pelo Supabase Auth (cadastro público fica desabilitado).
  //    Se o e-mail falhar, o perfil permanece como "convite pendente" e pode ser
  //    reenviado — nunca apagamos dados para desfazer.
  const sent = await sendInvite(req, profileId as string, p.email, p.name);
  if (!sent) {
    throw new AppError(502, "invite_failed",
      "O usuário foi cadastrado, mas o e-mail de convite não foi enviado. Use \"Reenviar convite\" em alguns minutos.");
  }
  return { profile_id: profileId, invited: true };
}

async function update(req: Request, p: UpdatePayload) {
  assertUuid(p.profile_id, "usuário");
  const { error } = await userClient(req).rpc("admin_update_user", {
    p_profile_id: p.profile_id,
    p_name: p.name,
    p_role: p.role,
    p_employment_type: p.employment_type ?? null,
    p_client_type: p.client_type ?? null,
    p_phone: p.phone ?? null,
    p_tenant_id: p.tenant_id ?? null,
  });
  if (error) throw fromPostgrest(error);
  return { updated: true };
}

async function setStatus(req: Request, p: StatusPayload) {
  assertUuid(p.profile_id, "usuário");
  if (p.status !== "ativo" && p.status !== "inativo") throw new AppError(422, "invalid", "Status inválido.");

  const { data: authUserId, error } = await userClient(req).rpc("admin_set_user_status", {
    p_profile_id: p.profile_id,
    p_status: p.status,
  });
  if (error) throw fromPostgrest(error);

  // Além do bloqueio no auth hook e no RLS, bane/libera no Auth para derrubar
  // sessões abertas imediatamente.
  if (authUserId) {
    const admin = serviceClient();
    const { error: banError } = await admin.auth.admin.updateUserById(authUserId, {
      ban_duration: p.status === "inativo" ? "876000h" : "none",
    });
    if (banError) {
      // O status já foi salvo e o banco já bloqueia o acesso; informamos o detalhe.
      return { updated: true, sessions_revoked: false };
    }
  }
  return { updated: true, sessions_revoked: true };
}

async function resendInvite(req: Request, p: ResendPayload) {
  assertUuid(p.profile_id, "usuário");
  // Leitura sob RLS: só retorna o perfil se o chamador pode gerenciá-lo.
  const user = userClient(req);
  const { data: perms, error: permError } = await user.rpc("my_permissions");
  if (permError || !perms?.can_manage_users) throw new AppError(403, "forbidden", "Você não pode reenviar convites.");
  const { data: profile, error } = await user.from("profiles")
    .select("id, email, name, tenant_id, status, auth_user_id").eq("id", p.profile_id).maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!profile) throw new AppError(404, "not_found", "Usuário não encontrado.");
  if (profile.status !== "ativo") throw new AppError(422, "invalid", "Reative o usuário antes de reenviar o convite.");

  if (!profile.auth_user_id) {
    // Convite original não chegou a ser criado no Auth: envia agora.
    const sent = await sendInvite(req, profile.id, profile.email, profile.name);
    if (!sent) throw new AppError(502, "invite_failed", "Não foi possível enviar o convite. Tente novamente em alguns minutos.");
  } else {
    const { error: linkError } = await serviceClient().auth.resetPasswordForEmail(profile.email, { redirectTo: redirectUrl(req) });
    if (linkError) throw new AppError(502, "invite_failed", "Não foi possível reenviar o convite. Tente novamente em alguns minutos.");
  }
  return { sent: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  try {
    const payload = (await req.json()) as Payload;
    switch (payload?.action) {
      case "invite":        return json(req, 200, await invite(req, payload));
      case "update":        return json(req, 200, await update(req, payload));
      case "set_status":    return json(req, 200, await setStatus(req, payload));
      case "resend_invite": return json(req, 200, await resendInvite(req, payload));
      default: throw new AppError(400, "bad_request", "Ação desconhecida.");
    }
  } catch (err) {
    if (err instanceof AppError) return json(req, err.status, { error: err.code, message: err.message });
    console.error("admin-users", err);
    return json(req, 500, { error: "unexpected", message: "Erro inesperado. Nada foi alterado." });
  }
});
