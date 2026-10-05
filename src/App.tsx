import type { ReactNode } from "react";
import { Navigate, Router, Routes, useLocation } from "@/lib/router";
import { AuthProvider, useAuth } from "@/services/auth";
import { supabaseMisconfigured } from "@/services/supabase";
import { can, type Capability } from "@/permissions";
import { AppLayout } from "@/layouts/AppLayout";
import { ToastProvider } from "@/components/ui/overlays";
import { BrandMark } from "@/components/domain/Brand";
import { Alert, EmptyState } from "@/components/ui/primitives";
import { Link } from "@/lib/router";
import { ForgotPasswordPage, LoginPage, SetPasswordPage } from "@/pages/auth/AuthPages";
import { HomePage } from "@/pages/home/HomePage";
import { AccessControlPage } from "@/pages/access/AccessControlPage";
import { UnitsPage } from "@/pages/units/UnitsPage";

function Boot() {
  return <div className="boot" aria-busy="true" aria-label="Carregando"><BrandMark className="boot__mark" /></div>;
}

/** Proteção de rota. A autorização real é feita pelo banco; aqui evitamos telas inúteis. */
function Protected({ children, requires = "home" }: { children: ReactNode; requires?: Capability }) {
  const { status, permissions } = useAuth();
  const { pathname, search } = useLocation();
  if (status === "loading") return <Boot />;
  if (status === "recovery") return <Navigate to="/redefinir-senha" />;
  if (status !== "signed_in") return <Navigate to={`/entrar?next=${encodeURIComponent(pathname + search)}`} />;
  return (
    <AppLayout>
      {can(permissions, requires) ? children : (
        <div className="page">
          <EmptyState icon="lock" title="Você não tem acesso a esta área."
            text="Se precisar deste acesso, fale com o administrador da sua unidade."
            action={<Link to="/" className="btn btn--secondary btn--sm">Voltar ao início</Link>} />
        </div>
      )}
    </AppLayout>
  );
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") return <Boot />;
  if (status === "signed_in") return <Navigate to="/" />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <Protected>
      <div className="page">
        <EmptyState icon="search" title="Página não encontrada."
          text="O endereço pode ter mudado ou esta área ainda não foi liberada."
          action={<Link to="/" className="btn btn--secondary btn--sm">Voltar ao início</Link>} />
      </div>
    </Protected>
  );
}

function ConfigError() {
  return (
    <div className="auth">
      <main className="auth__panel">
        <Alert tone="danger" title="Configuração incompleta">
          Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY nas variáveis de ambiente do projeto na Vercel e publique novamente.
        </Alert>
      </main>
    </div>
  );
}

export function App() {
  if (supabaseMisconfigured) return <ConfigError />;
  return (
    <Router>
      <AuthProvider>
        <ToastProvider>
          <Routes routes={[
            { path: "/entrar", element: <PublicOnly><LoginPage /></PublicOnly> },
            { path: "/esqueci-senha", element: <PublicOnly><ForgotPasswordPage /></PublicOnly> },
            { path: "/definir-senha", element: <SetPasswordPage mode="invite" /> },
            { path: "/redefinir-senha", element: <SetPasswordPage mode="reset" /> },
            { path: "/", element: <Protected><HomePage /></Protected> },
            { path: "/acessos", element: <Protected requires="manageUsers"><AccessControlPage /></Protected> },
            { path: "/unidades", element: <Protected requires="manageUnit"><UnitsPage /></Protected> },
            { path: "*", element: <NotFound /> },
          ]} />
        </ToastProvider>
      </AuthProvider>
    </Router>
  );
}
