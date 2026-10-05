import { useCallback, useEffect, useRef, useState } from "react";
import { toUserError } from "@/services/errors";

/** Carrega dados assíncronos com estados explícitos e recarga manual. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const run = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      if (id === seq.current) setData(result);
    } catch (err) {
      if (id === seq.current) setError(toUserError(err, "Não foi possível carregar os dados.").message);
    } finally {
      if (id === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { void run(); }, [run]);

  return { data, error, loading, reload: run, setData };
}

export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== "undefined" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export const useIsMobile = () => useMediaQuery("(max-width: 767px)");

export type Theme = "dark" | "light";

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
  );
  const setTheme = useCallback((t: Theme) => {
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#000000" : "#fafafa");
    try { localStorage.setItem("yc-theme", t); } catch { /* armazenamento indisponível */ }
    setThemeState(t);
  }, []);
  return [theme, setTheme];
}

/** Define o título da aba. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Portal YouCon` : "Portal de Projetos YouCon";
  }, [title]);
}
