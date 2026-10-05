// Sessão, perfil e permissões do usuário logado.
// O bloqueio real de inativos acontece no banco (auth hook + RLS); aqui apenas
// refletimos o estado e encerramos a sessão local quando o banco nega acesso.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { api } from "./api";
import { toUserError } from "./errors";
import type { Permissions, Profile } from "@/types/domain";

type AuthStatus = "loading" | "signed_out" | "signed_in" | "recovery";

interface AuthValue {
  status: AuthStatus;
  session: Session | null;
  profile: Profile | null;
  permissions: Permissions | null;
  /** Mensagem exibida na tela de login (ex.: acesso inativo). */
  notice: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

const INACTIVE_MESSAGE = "Seu acesso está inativo ou ainda não foi liberado. Fale com o administrador da sua unidade.";

function translateAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "E-mail ou senha incorretos.";
  if (m.includes("email not confirmed")) return "Confirme seu e-mail pelo link do convite antes de entrar.";
  if (m.includes("user is banned") || m.includes("banned")) return INACTIVE_MESSAGE;
  if (m.includes("rate limit") || m.includes("too many")) return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
  if (m.includes("password should")) return "A senha não atende aos requisitos mínimos.";
  if (m.includes("same password") || m.includes("different from the old")) return "A nova senha precisa ser diferente da atual.";
  if (m.includes("failed to fetch")) return "Sem conexão com o servidor. Verifique sua internet.";
  // Mensagens do auth hook (inativo, sem convite) já vêm em português.
  if (/[áéíóúãõç]/i.test(message)) return message;
  return "Não foi possível entrar. Tente novamente em instantes.";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recovering = useRef(false);

  const loadIdentity = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null); setPermissions(null);
      setStatus(recovering.current ? "recovery" : "signed_out");
      return;
    }
    try {
      const perms = await api.myPermissions();
      if (!perms) {
        // Banco não reconhece um perfil ativo: encerra a sessão local.
        setNotice(INACTIVE_MESSAGE);
        await supabase.auth.signOut();
        return;
      }
      const prof = await api.myProfile(perms.profile_id);
      setPermissions(perms);
      setProfile(prof);
      setStatus(recovering.current ? "recovery" : "signed_in");
    } catch (err) {
      setNotice(toUserError(err, "Não foi possível carregar seu acesso. Entre novamente.").message);
      await supabase.auth.signOut();
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      void loadIdentity(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") recovering.current = true;
      if (event === "SIGNED_OUT") recovering.current = false;
      setSession(s);
      if (event === "TOKEN_REFRESHED") return; // identidade não muda
      // Fora do callback para não bloquear o cliente de auth.
      setTimeout(() => { if (mounted) void loadIdentity(s); }, 0);
    });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, [loadIdentity]);

  const signIn = useCallback(async (email: string, password: string) => {
    setNotice(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) throw new Error(translateAuthError(error.message));
  }, []);

  const signOut = useCallback(async () => {
    recovering.current = false;
    await supabase.auth.signOut();
  }, []);

  const requestPasswordReset = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${window.location.origin}/redefinir-senha`,
    });
    // Não revelamos se o e-mail existe; só falhas de rede/limite são exibidas.
    if (error && /rate|fetch|network/i.test(error.message)) throw new Error(translateAuthError(error.message));
  }, []);

  const updatePassword = useCallback(async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(translateAuthError(error.message));
    recovering.current = false;
    await loadIdentity((await supabase.auth.getSession()).data.session);
  }, [loadIdentity]);

  const refresh = useCallback(async () => { await loadIdentity(session); }, [loadIdentity, session]);

  const value = useMemo<AuthValue>(() => ({
    status, session, profile, permissions, notice,
    signIn, signOut, requestPasswordReset, updatePassword, refresh,
  }), [status, session, profile, permissions, notice, signIn, signOut, requestPasswordReset, updatePassword, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth fora de <AuthProvider>");
  return ctx;
}
