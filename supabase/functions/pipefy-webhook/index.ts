// Edge Function: webhook do Pipefy (automação "Enviar requisição HTTP" na fase "Ganho").
//
// Segurança:
//   * verify_jwt desligado (o Pipefy não envia JWT do Supabase); a autenticação é
//     um token secreto no cabeçalho X-YouCon-Token, comparado com o hash no banco.
//   * Somente POST com JSON, até 256 KB.
//   * Idempotência e validação ficam no banco (public.ingest_crm_webhook).
import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_BYTES = 256 * 1024;

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { ok: false, error: "Use POST." });

  const token = req.headers.get("x-youcon-token") ?? "";
  if (token.length < 32) return reply(401, { ok: false, error: "Token ausente ou inválido." });

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return reply(415, { ok: false, error: "Envie o corpo como application/json." });
  }

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BYTES) return reply(413, { ok: false, error: "Corpo muito grande." });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return reply(400, { ok: false, error: "JSON inválido. Verifique as aspas e vírgulas do corpo da automação." });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return reply(400, { ok: false, error: "O corpo deve ser um objeto JSON." });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: valid, error: tokenError } = await admin.rpc("verify_integration_token", {
    p_source: "pipefy",
    p_token: token,
  });
  if (tokenError) {
    console.error("pipefy-webhook token", tokenError.message);
    return reply(500, { ok: false, error: "Falha ao validar o token. Tente novamente." });
  }
  if (!valid) return reply(401, { ok: false, error: "Token ausente ou inválido." });

  const { data, error } = await admin.rpc("ingest_crm_webhook", { p_source: "pipefy", p_payload: payload });
  if (error) {
    console.error("pipefy-webhook ingest", error.message);
    return reply(500, { ok: false, error: "Não foi possível registrar a venda. O Pipefy pode tentar novamente." });
  }

  // Entrada registrada: 200 mesmo com erro de validação (não adianta o Pipefy reenviar;
  // a correção é feita na Central de Entrada).
  return reply(200, { ok: true, ...(data as Record<string, unknown>) });
});
