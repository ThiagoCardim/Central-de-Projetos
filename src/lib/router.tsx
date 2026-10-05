// Roteador mínimo baseado na History API (sem dependências externas).
// Suporta padrões com parâmetros ("/projetos/:id"), Link/NavLink e redirecionamento.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type AnchorHTMLAttributes, type MouseEvent, type ReactNode,
} from "react";

interface Loc { pathname: string; search: string; hash: string }
interface RouterValue {
  location: Loc;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);
const ParamsContext = createContext<Record<string, string>>({});

function readLocation(): Loc {
  const { pathname, search, hash } = window.location;
  return { pathname, search, hash };
}

export function Router({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<Loc>(readLocation);

  useEffect(() => {
    const onPop = () => setLocation(readLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    const current = window.location.pathname + window.location.search;
    if (to === current) return;
    if (opts?.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setLocation(readLocation());
    window.scrollTo({ top: 0 });
  }, []);

  const value = useMemo(() => ({ location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter fora de <Router>");
  return ctx;
}

export const useLocation = () => useRouter().location;
export const useNavigate = () => useRouter().navigate;
export const useParams = () => useContext(ParamsContext);
export function useSearchParam(name: string): string | null {
  return new URLSearchParams(useLocation().search).get(name);
}

/** Retorna os parâmetros se o caminho casar com o padrão; senão null. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const clean = (s: string) => s.replace(/\/+$/, "") || "/";
  const pp = clean(pattern).split("/");
  const sp = clean(pathname).split("/");
  if (pattern.endsWith("/*")) {
    if (sp.length < pp.length - 1) return null;
  } else if (pp.length !== sp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i];
    if (seg === "*") return params;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(sp[i]);
    else if (seg !== sp[i]) return null;
  }
  return params;
}

export interface RouteDef { path: string; element: ReactNode }

/** Renderiza a primeira rota que casar. Use path "*" como fallback. */
export function Routes({ routes }: { routes: RouteDef[] }) {
  const { pathname } = useLocation();
  for (const r of routes) {
    const params = r.path === "*" ? {} : matchPath(r.path, pathname);
    if (params) return <ParamsContext.Provider value={params}>{r.element}</ParamsContext.Provider>;
  }
  return null;
}

export function Navigate({ to, replace = true }: { to: string; replace?: boolean }) {
  const navigate = useNavigate();
  useEffect(() => { navigate(to, { replace }); }, [to, replace, navigate]);
  return null;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string; replace?: boolean };

export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  const navigate = useNavigate();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target) return;
    e.preventDefault();
    navigate(to, { replace });
  };
  return <a href={to} onClick={handle} {...rest} />;
}

export function NavLink({ to, end, className, ...rest }: LinkProps & { end?: boolean; className?: string }) {
  const { pathname } = useLocation();
  const active = end ? pathname === to : pathname === to || pathname.startsWith(to.endsWith("/") ? to : to + "/");
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={[className, active ? "is-active" : ""].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}
