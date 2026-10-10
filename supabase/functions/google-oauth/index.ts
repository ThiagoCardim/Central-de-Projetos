// Edge Function: conecta a conta central do Google (OAuth) usada nas reuniões.
//
//   POST {action: "start", return_to}  (ADM Global logado) → { url } para abrir o consentimento do Google
//   GET  /google-oauth/callback?code&state                 → troca o código, guarda o refresh token e volta ao app
//
// verify_jwt = false (o retorno do Google não traz o JWT); o "start" valida o usuário pela RPC.
import { AppError, corsHeaders, fromPostgrest, json, serviceClient, userClient } from "../_shared/http.ts";
import { GOOGLE_SCOPES, googleConfigured, oauthRedirectUri } from "../_shared/google.ts";

function appBase(req: Request, wanted?: string | null): string {
  const allowed = (Deno.env.get("APP_ALLOWED_ORIGINS") ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  const configured = Deno.env.get("APP_URL")?.replace(/\/$/, "");
  const candidates = [configured, ...allowed].filter(Boolean) as string[];
  if (wanted) {
    try {
      const u = new URL(wanted);
      if (candidates.length === 0 || candidates.includes(u.origin)) return wanted;
    } catch { /* inválido */ }
  }
  return `${configured || allowed[0] || req.headers.get("origin") || ""}/configuracoes?aba=reunioes`;
}

async function start(req: Request, returnTo: string | null) {
  if (!googleConfigured()) {
    throw new AppError(422, "not_configured",
      "Faltam as credenciais do Google no servidor (GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET). Veja o passo a passo em Configurações › Reuniões.");
  }
  const back = appBase(req, returnTo ?? req.headers.get("origin"));
  const { data: state, error } = await userClient(req).rpc("google_oauth_start", { p_return: back });
  if (error) throw fromPostgrest(error);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
    redirect_uri: oauthRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: state as string,
  }).toString();
  return { url: url.toString() };
}

function back(to: string, result: string): Response {
  const u = new URL(to);
  u.searchParams.set("google", result);
  return new Response(null, { status: 302, headers: { Location: u.toString() } });
}

async function callback(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const db = serviceClient();
  const { data: st } = await db.rpc("google_oauth_take", { p_state: params.get("state") ?? "" });
  const info = st as { profile_id: string; return_to: string } | null;
  const fallback = appBase(req, null);
  if (!info) return back(fallback, "expired");
  if (params.get("error") || !params.get("code")) return back(info.return_to || fallback, "denied");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: params.get("code")!,
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      redirect_uri: oauthRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const tok = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tok.access_token) return back(info.return_to || fallback, "error");

  const missing = GOOGLE_SCOPES.filter((s) => s.startsWith("https://") && !(tok.scope ?? "").includes(s));
  if (missing.length) return back(info.return_to || fallback, "scopes");

  const me = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } })
    .then((r) => r.json()).catch(() => ({}));
  if (!me.email) return back(info.return_to || fallback, "error");

  const { error } = await db.rpc("google_account_save", {
    p_email: me.email, p_refresh: tok.refresh_token ?? null, p_scopes: tok.scope ?? "", p_profile: info.profile_id,
  });
  if (error) return back(info.return_to || fallback, "error");
  return back(info.return_to || fallback, "ok");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  try {
    if (req.method === "GET" && new URL(req.url).pathname.endsWith("/callback")) return await callback(req);
    if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });
    const payload = await req.json().catch(() => ({}));
    if (payload?.action === "start") return json(req, 200, await start(req, payload.return_to ?? null));
    throw new AppError(400, "bad_request", "Ação desconhecida.");
  } catch (err) {
    if (err instanceof AppError) return json(req, err.status, { error: err.code, message: err.message });
    console.error("google-oauth", err);
    return json(req, 500, { error: "unexpected", message: "Erro inesperado. Nada foi alterado." });
  }
});
