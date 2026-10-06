// Serve o preview e tira screenshots por perfil/tela. Uso:
//   NODE_PATH=/opt/npm-tools/node_modules node scripts/preview/shoot.mjs [filtro]
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
const shots = path.join(here, "shots");
mkdirSync(shots, { recursive: true });
const req = createRequire(path.join(process.env.NODE_PATH.split(":")[0], "noop.js"));
const { chromium } = req("playwright");

const types = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".html": "text/html", ".map": "application/json" };
const server = createServer((rq, rs) => {
  const url = new URL(rq.url, "http://x");
  let file = path.join(dist, url.pathname);
  if (!existsSync(file) || url.pathname === "/") file = path.join(dist, "index.html");
  rs.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "text/html" });
  rs.end(readFileSync(file));
}).listen(4173);

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const filter = process.argv[2] ?? "";

const scenes = [
  { name: "login", url: "/entrar", vp: DESKTOP },
  { name: "home-global", url: "/?as=global_admin", vp: DESKTOP, full: true },
  { name: "home-unit-admin", url: "/?as=unit_admin", vp: DESKTOP, full: true },
  { name: "home-leader", url: "/?as=leader", vp: DESKTOP, full: true },
  { name: "home-clt", url: "/?as=clt", vp: DESKTOP, full: true },
  { name: "home-pj", url: "/?as=pj", vp: DESKTOP, full: true },
  { name: "home-client", url: "/?as=client", vp: DESKTOP, full: true },
  { name: "home-empty", url: "/?as=empty", vp: DESKTOP, full: true },
  { name: "home-leader-light", url: "/?as=leader", vp: DESKTOP, light: true, full: true },
  { name: "home-tablet", url: "/?as=leader", vp: { width: 900, height: 1100 }, full: true },
  { name: "access", url: "/acessos?as=global_admin", vp: DESKTOP, full: true },
  { name: "access-invite", url: "/acessos?as=unit_admin", vp: DESKTOP, action: async (p) => { await p.getByRole("button", { name: "Convidar usuário" }).first().click(); await p.locator(".role", { hasText: "Colaborador" }).click(); } },
  { name: "access-edit", url: "/acessos?as=global_admin", vp: DESKTOP, action: async (p) => { await p.getByText("Camila Rocha", { exact: true }).click(); } },
  { name: "units", url: "/unidades?as=global_admin", vp: DESKTOP, full: true },
  { name: "forbidden", url: "/unidades?as=leader", vp: DESKTOP },
  { name: "intake", url: "/entrada?as=global_admin", vp: DESKTOP, full: true },
  { name: "intake-edit", url: "/entrada?as=global_admin", vp: DESKTOP, action: async (p) => { await p.getByText("Gustavo Lima Arquitetura").first().click(); } },
  { name: "projects", url: "/projetos?as=global_admin", vp: DESKTOP, full: true },
  { name: "projects-active", url: "/projetos?as=leader&status=in_progress", vp: DESKTOP, full: true },
  { name: "project-awaiting", url: "/projetos/pr8?as=unit_admin", vp: DESKTOP, full: true },
  { name: "project-team", url: "/projetos/pr8?as=unit_admin&acao=equipe", vp: DESKTOP },
  { name: "project-alloc", url: "/projetos/pr9?as=global_admin&acao=distribuir", vp: DESKTOP },
  { name: "project-active", url: "/projetos/pr1?as=leader", vp: DESKTOP, full: true },
  { name: "projects-clt", url: "/projetos?as=clt&status=in_progress", vp: DESKTOP, full: true },
  { name: "clients", url: "/clientes?as=global_admin", vp: DESKTOP, full: true },
  { name: "team", url: "/equipe?as=unit_admin", vp: DESKTOP, full: true },
  { name: "intake-empty", url: "/entrada?as=empty", vp: DESKTOP },
  { name: "m-projects", url: "/projetos?as=global_admin", vp: MOBILE, full: true },
  { name: "m-project", url: "/projetos/pr1?as=leader", vp: MOBILE, full: true },
  { name: "m-team-drawer", url: "/projetos/pr8?as=unit_admin&acao=equipe", vp: MOBILE },
  { name: "m-intake", url: "/entrada?as=global_admin", vp: MOBILE, full: true },
  { name: "sched-tracks", url: "/projetos/pr1/cronograma?as=leader", vp: DESKTOP, full: true },
  { name: "sched-overview", url: "/projetos/pr1/cronograma?as=leader", vp: DESKTOP, full: true, action: async (p) => { await p.getByRole("tab", { name: "Visão geral" }).click(); } },
  { name: "sched-list", url: "/projetos/pr1/cronograma?as=leader", vp: DESKTOP, full: true, action: async (p) => { await p.getByRole("tab", { name: "Lista" }).click(); } },
  { name: "sched-manage", url: "/projetos/pr1/cronograma?as=leader", vp: DESKTOP, action: async (p) => { await p.getByRole("tab", { name: "Trilhas" }).click(); await p.getByRole("radio", { name: "Modo gestão" }).click(); } },
  { name: "sched-drawer", url: "/projetos/pr1/cronograma?as=leader", vp: { width: 1440, height: 1400 }, action: async (p) => { await p.getByRole("tab", { name: "Trilhas" }).click(); await p.getByRole("radio", { name: "Modo gestão" }).click(); await p.getByRole("button", { name: /^Estudo Preliminar/ }).first().click(); await p.waitForTimeout(500); } },
  { name: "sched-impact", url: "/projetos/pr1/cronograma?as=leader", vp: { width: 1440, height: 1300 }, action: async (p) => {
    await p.getByRole("tab", { name: "Trilhas" }).click(); await p.getByRole("radio", { name: "Modo gestão" }).click(); await p.getByRole("button", { name: /^Estudo Preliminar/ }).first().click();
    await p.getByRole("button", { name: "Ajustar prazo deste projeto" }).click();
    await p.getByLabel("Duração (dias úteis)").fill("25"); await p.getByRole("button", { name: "Ver impacto" }).click(); await p.waitForTimeout(500); } },
  { name: "sched-add", url: "/projetos/pr1/cronograma?as=leader", vp: DESKTOP, action: async (p) => { await p.getByRole("tab", { name: "Trilhas" }).click(); await p.getByRole("radio", { name: "Modo gestão" }).click(); await p.getByRole("button", { name: "Adicionar etapa" }).first().click(); } },
  { name: "sched-clt", url: "/projetos/pr1/cronograma?as=clt&etapa=tr-arq-estudo_preliminar", vp: DESKTOP },
  { name: "mysched-leader", url: "/cronograma?as=leader", vp: DESKTOP, full: true },
  { name: "mysched-clt", url: "/cronograma?as=clt", vp: DESKTOP, full: true },
  { name: "project-team-v2", url: "/projetos/pr1?as=leader", vp: DESKTOP, full: true },
  { name: "team-drawer-v2", url: "/projetos/pr1?as=leader&acao=equipe", vp: { width: 1440, height: 1200 } },
  { name: "templates", url: "/servicos?as=global_admin", vp: DESKTOP, full: true },
  { name: "templates-int", url: "/servicos?as=global_admin", vp: DESKTOP, full: true, action: async (p) => { await p.getByRole("button", { name: /Interiores/ }).first().click(); await p.waitForTimeout(400); } },
  { name: "templates-editor", url: "/servicos?as=global_admin", vp: { width: 1440, height: 1200 }, action: async (p) => { await p.getByRole("button", { name: "Alterar padrão YouCon" }).click(); await p.waitForTimeout(600); } },
  { name: "library", url: "/servicos?as=leader", vp: DESKTOP, full: true, action: async (p) => { await p.getByRole("tab", { name: "Biblioteca de etapas" }).click(); } },
  { name: "user-photo", url: "/acessos?as=global_admin", vp: DESKTOP, action: async (p) => { await p.getByText("Camila Rocha", { exact: true }).click(); } },
  { name: "m-sched", url: "/projetos/pr1/cronograma?as=leader", vp: MOBILE, full: true, action: async (p) => { await p.getByRole("tab", { name: "Trilhas" }).click(); } },
  { name: "m-home-leader", url: "/?as=leader", vp: MOBILE, full: true },
  { name: "m-home-client", url: "/?as=client", vp: MOBILE, full: true },
  { name: "m-access", url: "/acessos?as=unit_admin", vp: MOBILE, full: true },
  { name: "m-access-invite", url: "/acessos?as=unit_admin", vp: MOBILE, action: async (p) => { await p.getByRole("button", { name: "Convidar usuário" }).first().click(); await p.locator(".role", { hasText: "Acompanha somente" }).click(); } },
  { name: "m-menu", url: "/?as=global_admin", vp: MOBILE, action: async (p) => { await p.getByRole("button", { name: "Menu", exact: true }).click(); } },
  { name: "m-login", url: "/entrar", vp: MOBILE },
];

const browser = await chromium.launch();
let failures = 0;
for (const s of scenes.filter((x) => x.name.includes(filter))) {
  const ctx = await browser.newContext({ viewport: s.vp, deviceScaleFactor: 1, colorScheme: s.light ? "light" : "dark", isMobile: s.vp.width < 768, hasTouch: s.vp.width < 768 });
  if (s.light) await ctx.addInitScript(() => localStorage.setItem("yc-theme", "light"));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("ERR_FAILED") && !m.text().includes("ERR_TUNNEL") && !m.text().includes("fonts.g")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://localhost:4173${s.url}`);
  await page.waitForTimeout(900);
  if (s.action) { await s.action(page); await page.waitForTimeout(500); }
  await page.screenshot({ path: path.join(shots, `${s.name}.png`), fullPage: !!s.full });
  if (errors.length) { failures++; console.log(`✗ ${s.name}\n   ${errors.join("\n   ")}`); }
  else console.log(`✓ ${s.name}`);
  await ctx.close();
}
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
