// Utilitários HTTP compartilhados pelas Edge Functions.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = (Deno.env.get("APP_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow || "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Erro com mensagem segura para o usuário final. */
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Converte erros do Postgres (RPC) em respostas compreensíveis. */
export function fromPostgrest(error: { code?: string; message: string }): AppError {
  switch (error.code) {
    case "42501":
      return new AppError(403, "forbidden", error.message || "Você não tem permissão para esta ação.");
    case "23505":
      return new AppError(409, "conflict", error.message || "Registro já existe.");
    case "P0002":
      return new AppError(404, "not_found", error.message || "Registro não encontrado.");
    case "23514":
    case "23503":
    case "22P02":
      return new AppError(422, "invalid", error.message || "Dados inválidos.");
    default:
      return new AppError(500, "unexpected", "Não foi possível concluir a operação. Nada foi alterado.");
  }
}

/** Cliente com o JWT do chamador: tudo que ele fizer passa pelo RLS. */
export function userClient(req: Request): SupabaseClient {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new AppError(401, "unauthenticated", "Sessão expirada. Entre novamente.");
  }
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Cliente de serviço: SOMENTE após a permissão ter sido validada no banco. */
export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
