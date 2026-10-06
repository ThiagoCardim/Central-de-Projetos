import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParam } from "@/lib/router";
import { useAuth } from "@/services/auth";
import { Alert, Button, Field, Input } from "@/components/ui/primitives";
import { BrandMark } from "@/components/domain/Brand";
import { useDocumentTitle } from "@/hooks";
import { authLinkError } from "@/services/supabase";

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth">
      <main className="auth__panel">
        <div className="auth__brand">
          <BrandMark className="auth__mark" />
          <span>
            <strong>YouCon</strong>
            <span className="muted">Portal de Projetos</span>
          </span>
        </div>
        <div className="auth__head">
          <h1>{title}</h1>
          {subtitle && <p className="subtext">{subtitle}</p>}
        </div>
        {children}
        {footer && <div className="auth__foot">{footer}</div>}
      </main>
      <p className="auth__legal">Acesso somente por convite. Dúvidas? Fale com o administrador da sua unidade.</p>
    </div>
  );
}

/** Mesmas regras do Supabase Auth (config.toml): 10+ caracteres, maiúscula, minúscula e número. */
function passwordIssues(pw: string): string[] {
  const issues: string[] = [];
  if (pw.length < 10) issues.push("10 caracteres");
  if (!/[a-z]/.test(pw)) issues.push("uma letra minúscula");
  if (!/[A-Z]/.test(pw)) issues.push("uma letra maiúscula");
  if (!/\d/.test(pw)) issues.push("um número");
  return issues;
}

export function LoginPage() {
  useDocumentTitle("Entrar");
  const { signIn, notice } = useAuth();
  const navigate = useNavigate();
  const next = useSearchParam("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email || !password) { setError("Informe e-mail e senha."); return; }
    setLoading(true); setError(null);
    try {
      await signIn(email, password);
      navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Entrar" subtitle="Use o e-mail em que você recebeu o convite.">
      <form className="stack" onSubmit={submit} noValidate>
        {(error || notice || authLinkError) && (
          <Alert tone={error || notice ? "danger" : "warning"}>{error ?? notice ?? authLinkError}</Alert>
        )}
        <Field label="E-mail">
          {({ id }) => (
            <Input id={id} type="email" large autoComplete="username" inputMode="email" autoFocus
              value={email} onChange={(e) => setEmail(e.target.value)} />
          )}
        </Field>
        <Field label="Senha">
          {({ id }) => (
            <Input id={id} type="password" large autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
        </Field>
        <div className="auth__row">
          <Link to="/esqueci-senha" className="link">Esqueci minha senha</Link>
        </div>
        <Button type="submit" size="lg" block loading={loading}>Entrar</Button>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  useDocumentTitle("Recuperar senha");
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setError("Informe um e-mail válido."); return; }
    setLoading(true); setError(null);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Recuperar senha"
      subtitle={sent ? undefined : "Enviaremos um link para você criar uma nova senha."}
      footer={<Link to="/entrar" className="link">Voltar para entrar</Link>}
    >
      {sent ? (
        <Alert tone="info" title="Verifique seu e-mail">
          Se {email} tiver acesso ao portal, você receberá um link em alguns minutos. Confira também a caixa de spam.
        </Alert>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          <Field label="E-mail" error={error}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="email" large autoComplete="email" inputMode="email" autoFocus
                aria-describedby={describedBy} aria-invalid={invalid}
                value={email} onChange={(e) => setEmail(e.target.value)} />
            )}
          </Field>
          <Button type="submit" size="lg" block loading={loading}>Enviar link</Button>
        </form>
      )}
    </AuthShell>
  );
}

/** Usada pelo link do convite (/definir-senha) e pela recuperação (/redefinir-senha). */
export function SetPasswordPage({ mode }: { mode: "invite" | "reset" }) {
  useDocumentTitle(mode === "invite" ? "Criar senha" : "Nova senha");
  const { status, session, updatePassword, confirmEmailLink } = useAuth();
  const navigate = useNavigate();
  const tokenHash = useSearchParam("token_hash");
  const [confirming, setConfirming] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const issues = passwordIssues(password);
  const mismatch = confirm.length > 0 && confirm !== password;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (issues.length || mismatch || !confirm) return;
    setLoading(true); setError(null);
    try {
      await updatePassword(password);
      navigate("/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function confirmLink() {
    if (!tokenHash) return;
    setConfirming(true); setLinkError(null);
    try {
      await confirmEmailLink(tokenHash, mode === "invite" ? "invite" : "recovery");
      // Remove o código da barra de endereço depois de usado.
      window.history.replaceState(null, "", window.location.pathname);
    } catch (err) {
      setLinkError((err as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  if (status === "loading") {
    return <AuthShell title="Validando link…"><p className="subtext">Um instante.</p></AuthShell>;
  }

  // Link do e-mail ainda não confirmado: exige um clique (verificadores de e-mail não clicam).
  if (tokenHash && !session) {
    return (
      <AuthShell
        title={mode === "invite" ? "Ative seu acesso" : "Redefinir senha"}
        subtitle={mode === "invite"
          ? "Você foi convidado para o Portal de Projetos YouCon."
          : "Confirme para criar uma nova senha."}
        footer={linkError ? <Link to="/esqueci-senha" className="link">Pedir um novo link</Link> : undefined}
      >
        {linkError && <Alert tone="danger">{linkError}</Alert>}
        <Button size="lg" block loading={confirming} onClick={confirmLink}>Continuar</Button>
      </AuthShell>
    );
  }

  if (!session) {
    return (
      <AuthShell title="Link expirado" footer={<Link to="/entrar" className="link">Voltar para entrar</Link>}>
        <Alert tone="warning" title="Este link não é mais válido">
          {mode === "invite"
            ? "Peça ao administrador da sua unidade para reenviar o convite."
            : "Solicite um novo link de recuperação de senha."}
        </Alert>
        {mode === "reset" && <Link to="/esqueci-senha" className="btn btn--secondary btn--lg btn--block">Solicitar novo link</Link>}
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={mode === "invite" ? "Crie sua senha" : "Defina uma nova senha"}
      subtitle={mode === "invite" ? "Último passo para acessar o Portal de Projetos." : undefined}
    >
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Nova senha" hint="Mínimo de 10 caracteres, com maiúscula, minúscula e número."
          error={touched && issues.length ? `Falta: ${issues.join(", ")}.` : null}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="password" large autoComplete="new-password" autoFocus
              aria-describedby={describedBy} aria-invalid={invalid}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
        </Field>
        <Field label="Confirme a senha" error={(touched || confirm.length >= password.length) && mismatch ? "As senhas não coincidem." : null}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="password" large autoComplete="new-password"
              aria-describedby={describedBy} aria-invalid={invalid}
              value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          )}
        </Field>
        <Button type="submit" size="lg" block loading={loading}>
          {mode === "invite" ? "Criar senha e entrar" : "Salvar nova senha"}
        </Button>
      </form>
    </AuthShell>
  );
}
