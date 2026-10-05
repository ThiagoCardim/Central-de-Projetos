// Build de PREVIEW local (sem npm install): usa React/esbuild pré-instalados e o
// Supabase simulado. Uso: node scripts/preview/build.mjs  (NODE_PATH com react/esbuild)
import { createRequire } from "node:module";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "scripts/preview/dist");
const nodePaths = (process.env.NODE_PATH ?? "").split(":").filter(Boolean);
// ESM não lê NODE_PATH: resolve o esbuild a partir dos caminhos informados.
const { build } = createRequire(path.join(nodePaths[0] ?? root, "noop.js"))("esbuild");
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/main.tsx")],
  bundle: true,
  outdir: out,
  entryNames: "app",
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  sourcemap: true,
  nodePaths,
  loader: { ".css": "css" },
  alias: {
    "@": path.join(root, "src"),
    "@supabase/supabase-js": path.join(root, "scripts/preview/supabase-mock.ts"),
  },
  define: {
    "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "http://mock.local", VITE_SUPABASE_ANON_KEY: "mock", DEV: true }),
    "process.env.NODE_ENV": '"development"',
  },
  logLevel: "warning",
});

const html = readFileSync(path.join(root, "index.html"), "utf8")
  .replace('<script type="module" src="/src/main.tsx"></script>', '<script type="module" src="/app.js"></script>')
  .replace("</head>", '    <link rel="stylesheet" href="/app.css" />\n  </head>');
writeFileSync(path.join(out, "index.html"), html);
cpSync(path.join(root, "public"), out, { recursive: true });
console.log("preview build ok →", out);
