import type { DeliveryItem, DeliveryKind, DeliveryStatus, DeliveryVersion } from "@/types/domain";

/* Rótulos e regras de tela das entregas (as regras de verdade estão no banco). */
export function statusLabel(it: DeliveryItem, client: boolean): string {
  const s: DeliveryStatus = it.status;
  if (s === "in_production") return "Em produção";
  if (s === "awaiting_client") return client ? "Aguardando sua avaliação" : "Aguardando o cliente";
  if (s === "revision_requested") return `Revisão ${it.open_request?.round ?? ""} em produção`.replace("  ", " ");
  if (s === "detailing") return "Em detalhamento";
  if (s === "final") return "Projeto final entregue";
  return "Entregue";
}
export const STATUS_TONE: Record<DeliveryStatus, "neutral" | "brand" | "warning" | "success"> = {
  in_production: "neutral", awaiting_client: "warning", revision_requested: "brand", detailing: "brand", final: "success", delivered: "success",
};

export const KIND_LABEL: Record<DeliveryKind, string> = {
  presentation: "Apresentação", revision: "Revisão", final: "Projeto final", document: "Documentos",
};
export const versionBadge = (v: DeliveryVersion) =>
  v.kind === "revision" ? `Revisão ${v.round}` : v.kind === "presentation" ? "Apresentação" : v.kind === "final" ? "Final" : "Documento";

/** Próxima versão que a equipe pode preparar (null = aguardando o cliente). */
export function nextKind(it: DeliveryItem): { kind: DeliveryKind; label: string } | null {
  if (it.project_service_id == null) return { kind: "document", label: "Adicionar documentos" };
  if (!it.revisions_enabled) return { kind: "final", label: it.last_final_version_id ? "Publicar nova entrega" : "Preparar entrega" };
  if (it.status === "in_production") return { kind: "presentation", label: "Preparar apresentação preliminar" };
  if (it.status === "revision_requested") return { kind: "revision", label: `Preparar revisão ${it.open_request?.round ?? ""}`.trim() };
  if (it.status === "detailing") return { kind: "final", label: "Preparar projeto final" };
  if (it.status === "final") return { kind: "final", label: "Publicar nova versão do projeto final" };
  return null;
}

export const remaining = (it: DeliveryItem) => Math.max(0, it.allowed - it.used);
export const extrasApproved = (it: DeliveryItem) => it.extras.filter((e) => e.status === "approved").length;

export const fmtSize = (n: number | null) =>
  n == null ? "" : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export const AREA_LABEL: Record<string, string> = { architecture: "Arquitetura", engineering: "Engenharia", approval: "Aprovação" };
