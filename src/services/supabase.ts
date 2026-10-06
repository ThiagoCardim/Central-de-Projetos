import { createClient } from "@supabase/supabase-js";

const env = import.meta.env as Record<string, string | undefined>;
const url = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Links de convite/recuperação podem chegar em qualquer rota (ex.: convite enviado
// pelo painel do Supabase cai na Site URL). Antes de o cliente consumir o hash,
// encaminha para a tela de definir senha correspondente.
if (typeof window !== "undefined") {
  const hashType = new URLSearchParams(window.location.hash.slice(1)).get("type");
  const target = hashType === "invite" ? "/definir-senha" : hashType === "recovery" ? "/redefinir-senha" : null;
  if (target && window.location.pathname !== target) {
    window.history.replaceState(null, "", target + window.location.hash);
  }
}

/** true quando as variáveis de ambiente não foram configuradas (ex.: deploy sem env). */
export const supabaseMisconfigured = !url || !anonKey;

export const supabase = createClient(url ?? "http://localhost:54321", anonKey ?? "missing-anon-key", {
  auth: {
    persistSession: true,          // sessão persistente
    autoRefreshToken: true,
    detectSessionInUrl: true,      // links de convite e recuperação de senha
    // Implícito: convites e recuperações são disparados pelo servidor (Edge Function),
    // então não há code_verifier no navegador para o fluxo PKCE.
    flowType: "implicit",
    storageKey: "yc-auth",
  },
});
