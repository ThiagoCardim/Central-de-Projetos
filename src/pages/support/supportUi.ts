import type { SupportStatus, SupportTarget } from "@/types/domain";

/* Rótulos e utilitários do atendimento "Preciso de ajuda". */
export const TARGET_LABEL: Record<SupportTarget, string> = {
  architecture: "Líder de Arquitetura", engineering: "Líder de Engenharia", approval: "Líder de Aprovação", cs: "Customer Success",
};
export const TARGET_SHORT: Record<SupportTarget, string> = {
  architecture: "Arquitetura", engineering: "Engenharia", approval: "Aprovação", cs: "Customer Success",
};
export const SUPPORT_STATUS: Record<SupportStatus, { label: string; tone: "warning" | "success" | "danger" }> = {
  open: { label: "Aguardando validação", tone: "warning" },
  resolved: { label: "Resolvido", tone: "success" },
  unresolved: { label: "Não resolvido", tone: "danger" },
};

/** Só dígitos com DDI 55 quando vier DDD + número (mesma regra do banco). */
export function waDigits(v: string | null | undefined): string | null {
  let d = (v ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.length >= 12 && d.length <= 15 ? d : null;
}

/** +55 (35) 99999-1111 */
export function formatWhatsapp(v: string | null | undefined): string {
  const d = waDigits(v);
  if (!d) return v ?? "";
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4); const n = d.slice(4);
    return `+55 (${ddd}) ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
  }
  return `+${d}`;
}

export const waLink = (digits: string, text?: string) => `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;

export const TEMPLATE_VARS: { key: string; label: string; sample: string }[] = [
  { key: "{lider}", label: "Nome de quem atende", sample: "Bruno" },
  { key: "{cliente}", label: "Nome do cliente", sample: "Fernanda" },
  { key: "{projeto}", label: "Nome do projeto", sample: "Residência Souza" },
  { key: "{assunto}", label: "Assunto escolhido", sample: "engenharia" },
  { key: "{mensagem}", label: "O que o cliente escreveu", sample: "Tenho uma dúvida sobre a laje." },
];

/** Prévia da mensagem com valores de exemplo (o banco monta a mensagem real). */
export function previewTemplate(tpl: string, withMessage = true): string {
  let out = tpl;
  for (const v of TEMPLATE_VARS) out = out.split(v.key).join(v.key === "{mensagem}" && !withMessage ? "" : v.sample);
  return out.replace(/\s{2,}/g, " ").trim();
}

export function timeAgo(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const days = Math.round(h / 24);
  return days === 1 ? "ontem" : `há ${days} dias`;
}
