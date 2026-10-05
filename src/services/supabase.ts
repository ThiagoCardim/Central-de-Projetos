import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

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
