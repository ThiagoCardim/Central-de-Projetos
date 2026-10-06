/** Erro com mensagem já pronta para o usuário: o que aconteceu e o que fazer. */
export class UserFacingError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

interface PgLikeError { code?: string; message?: string; details?: string | null }

/** Traduz erros do Postgres/PostgREST para mensagens claras. */
export function toUserError(err: unknown, fallback = "Não foi possível concluir. Nada foi alterado. Tente novamente."): UserFacingError {
  if (err instanceof UserFacingError) return err;
  const e = (err ?? {}) as PgLikeError;
  const msg = e.message ?? "";
  switch (e.code) {
    case "42501":
      // Mensagens das guardas do banco já são escritas para o usuário.
      return new UserFacingError(
        msg && !msg.startsWith("new row violates") && !msg.startsWith("permission denied")
          ? msg
          : "Você não tem permissão para esta ação. Nada foi alterado.",
        e.code,
      );
    case "23505":
      return new UserFacingError(msg.includes("profiles_email") ? "Já existe um usuário com este e-mail." :
        msg.includes("tenants_slug") ? "Já existe uma unidade com este identificador." :
        msg.includes("clients_tenant_document") ? "Já existe um cliente com este CPF/CNPJ nesta unidade." : "Este registro já existe.", e.code);
    case "P0002":
    case "23514":
    case "23503":
      return new UserFacingError(msg || "Dados inválidos. Revise os campos e tente novamente.", e.code);
    case "PGRST301":
      return new UserFacingError("Sua sessão expirou. Entre novamente.", e.code);
  }
  if (msg.toLowerCase().includes("failed to fetch") || msg.toLowerCase().includes("network")) {
    return new UserFacingError("Sem conexão com o servidor. Verifique sua internet. Nada foi alterado.");
  }
  return new UserFacingError(fallback, e.code);
}
