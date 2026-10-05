import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  // NEXT_PUBLIC_* vem da integração Supabase ↔ Vercel. Somente variáveis públicas
  // (URL e anon key) usam esses prefixos; chaves secretas nunca entram no bundle.
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { target: "es2022", sourcemap: false },
});
