/**
 * E06 — regras PURAS de modelos de mensagem: campos permitidos, validação, renderização e agenda da régua.
 * O corpo é TEXTO SIMPLES. Nunca é interpretado como HTML: valores são escapados na saída HTML e o assunto não aceita quebra de linha.
 */
import { addDays } from "./dates";

export const KINDS = ["emissao", "d_menos_3", "d0", "d_mais_3", "d_mais_7"] as const;
export type Kind = (typeof KINDS)[number];
export type QueueKind = Kind | "revisao_d15";
export const CHANNELS = ["email", "whatsapp"] as const;
export type Channel = (typeof CHANNELS)[number];

export const KIND_LABEL: Record<QueueKind, string> = {
  emissao: "Emissão (cobrança emitida)", d_menos_3: "Lembrete D-3", d0: "Vencimento (D0)", d_mais_3: "Atraso D+3", d_mais_7: "Atraso D+7", revisao_d15: "Revisão humana D+15",
};
export const CHANNEL_LABEL: Record<Channel | "interno", string> = { email: "E-mail", whatsapp: "WhatsApp", interno: "Interno" };
/** Dias em relação ao vencimento; `emissao` usa a data de emissão da cobrança. */
export const OFFSET: Record<Exclude<QueueKind, "emissao">, number> = { d_menos_3: -3, d0: 0, d_mais_3: 3, d_mais_7: 7, revisao_d15: 15 };

export const PLACEHOLDERS = ["cliente", "empresa", "valor", "vencimento", "competencia", "descricao", "emissao", "linha_digitavel", "link_boleto", "pix_copia_cola"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export const PLACEHOLDER_HELP: Record<Placeholder, string> = {
  cliente: "Nome do cliente", empresa: "Nome da empresa emissora", valor: "Valor da cobrança (R$)", vencimento: "Data de vencimento",
  competencia: "Mês de competência (MM/AAAA)", descricao: "Descrição do serviço", emissao: "Data de emissão",
  linha_digitavel: "Linha digitável do boleto (consultada na Cora; o PDF segue em anexo no e-mail)", link_boleto: "Link do PDF do boleto na Cora", pix_copia_cola: "Pix copia e cola do boleto (vazio se o boleto não tem QR Code Pix)",
};

const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

export type TemplateIssue = { ok: false; error: string } | { ok: true };

export function validateTemplate(channel: Channel, subject: string, body: string): TemplateIssue {
  if (!body.trim()) return { ok: false, error: "O texto da mensagem é obrigatório" };
  if (body.length > 4000) return { ok: false, error: "O texto passa de 4.000 caracteres" };
  if (channel === "email") {
    if (!subject.trim()) return { ok: false, error: "O assunto é obrigatório no e-mail" };
    if (subject.length > 200) return { ok: false, error: "O assunto passa de 200 caracteres" };
  } else if (subject.trim()) return { ok: false, error: "WhatsApp não tem assunto" };
  if (/[\r\n]/.test(subject)) return { ok: false, error: "O assunto deve ter uma linha só" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(subject + body)) return { ok: false, error: "O texto tem caracteres de controle inválidos" };
  if (/<\s*\/?\s*[a-z!][^>]*>/i.test(subject + body)) return { ok: false, error: "Use apenas texto simples: HTML não é permitido" };
  const left = (subject + body).replace(TOKEN, "");
  if (/\{\{|\}\}/.test(left)) return { ok: false, error: "Chaves {{ }} mal formadas" };
  for (const m of (subject + "\n" + body).matchAll(TOKEN)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(m[1])) return { ok: false, error: `Campo desconhecido: {{${m[1]}}}. Permitidos: ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}` };
  }
  return { ok: true };
}

export type Vars = Record<Placeholder, string>;
const clean = (v: string) => v.replace(/\s*[\r\n\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+\s*/g, " ").trim();

/** Substitui só os campos permitidos. Valores não são reinterpretados (sem recursão): `{{x}}` dentro de um nome fica literal. */
export function render(text: string, vars: Vars): string {
  return text.replace(TOKEN, (_all, k: string) => ((PLACEHOLDERS as readonly string[]).includes(k) ? clean(vars[k as Placeholder]) : ""));
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);
/** Versão HTML segura para e-mail: texto já renderizado → escapado, com quebras de linha. */
export const toEmailHtml = (renderedText: string) => escapeHtml(renderedText).replace(/\r?\n/g, "<br>");

/** Dados fictícios para a prévia do editor (nunca dados reais). */
export const SAMPLE_VARS: Vars = {
  cliente: "Cliente Exemplo Ltda", empresa: "Empresa Exemplo", valor: "R$ 2.500,00", vencimento: "14/11/2026", competencia: "10/2026", descricao: "Monitoramento de redes", emissao: "01/11/2026", linha_digitavel: "00190.00009 03215.837001 25845.801747 9 14200000250000", link_boleto: "https://exemplo.cora.com.br/boleto.pdf", pix_copia_cola: "00020126580014br.gov.bcb.pix0136exemplo",
};

/** Agenda da régua para uma cobrança aprovada. Fim de semana/feriado e janela de envio entram na E09. */
export function ladder(c: { issueDate: string; dueDate: string }): { kind: QueueKind; date: string }[] {
  return [
    { kind: "emissao", date: c.issueDate },
    ...(["d_menos_3", "d0", "d_mais_3", "d_mais_7", "revisao_d15"] as const).map((k) => ({ kind: k as QueueKind, date: addDays(c.dueDate, OFFSET[k]) })),
  ];
}

export const DEFAULTS: Record<Kind, { subject: string; body: string }> = {
  emissao: { subject: "Cobrança {{empresa}} — vencimento {{vencimento}}", body: "Olá, {{cliente}}.\n\nSua cobrança de {{valor}} referente a {{descricao}} (competência {{competencia}}) foi emitida e vence em {{vencimento}}.\n\nLinha digitável do boleto:\n{{linha_digitavel}}\nO PDF do boleto segue em anexo.\n\nQualquer dúvida, responda esta mensagem.\n\n{{empresa}}" },
  d_menos_3: { subject: "Lembrete: cobrança vence em {{vencimento}}", body: "Olá, {{cliente}}.\n\nLembramos que a cobrança de {{valor}} ({{descricao}}) vence em {{vencimento}}.\n\nLinha digitável do boleto:\n{{linha_digitavel}}\nO PDF do boleto segue em anexo.\n\nSe já pagou, desconsidere esta mensagem.\n\n{{empresa}}" },
  d0: { subject: "Sua cobrança vence hoje ({{vencimento}})", body: "Olá, {{cliente}}.\n\nSua cobrança de {{valor}} ({{descricao}}) vence hoje, {{vencimento}}.\n\nLinha digitável do boleto:\n{{linha_digitavel}}\nO PDF do boleto segue em anexo.\n\nSe já pagou, desconsidere esta mensagem.\n\n{{empresa}}" },
  d_mais_3: { subject: "Cobrança em aberto desde {{vencimento}}", body: "Olá, {{cliente}}.\n\nNão identificamos o pagamento de {{valor}} ({{descricao}}), vencido em {{vencimento}}.\n\nLinha digitável do boleto:\n{{linha_digitavel}}\nO PDF do boleto segue em anexo.\n\nSe já pagou, desconsidere. Caso precise de ajuda, responda esta mensagem.\n\n{{empresa}}" },
  d_mais_7: { subject: "Cobrança em aberto — {{empresa}}", body: "Olá, {{cliente}}.\n\nA cobrança de {{valor}} ({{descricao}}), vencida em {{vencimento}}, segue em aberto.\n\nLinha digitável do boleto:\n{{linha_digitavel}}\nO PDF do boleto segue em anexo.\n\nSe houver algum problema, fale conosco para combinarmos a melhor solução.\n\n{{empresa}}" },
};

/** Textos padrão do WhatsApp (curtos, sem dados do boleto, com identificação da empresa e a saída «responda PARAR»). O «PARAR» só é honrado depois que o receptor de respostas (entrega 3b) estiver no ar. */
export const WA_DEFAULTS: Record<Kind, string> = {
  emissao: "Olá, {{cliente}}. Aqui é o financeiro da {{empresa}}. Sua cobrança de {{valor}} ({{descricao}}) vence em {{vencimento}}. Se já pagou, desconsidere. Para não receber avisos no WhatsApp, responda PARAR.",
  d_menos_3: "Olá, {{cliente}}. Lembrete do financeiro da {{empresa}}: a cobrança de {{valor}} vence em {{vencimento}}. Se já pagou, desconsidere. Para não receber avisos no WhatsApp, responda PARAR.",
  d0: "Olá, {{cliente}}. O financeiro da {{empresa}} lembra que a cobrança de {{valor}} vence hoje ({{vencimento}}). Se já pagou, desconsidere. Para não receber avisos no WhatsApp, responda PARAR.",
  d_mais_3: "Olá, {{cliente}}. Não identificamos o pagamento de {{valor}} ({{descricao}}), vencido em {{vencimento}}. Se já pagou, desconsidere; se precisar de ajuda, responda esta mensagem. Para não receber avisos no WhatsApp, responda PARAR.",
  d_mais_7: "Olá, {{cliente}}. A cobrança de {{valor}} ({{descricao}}), vencida em {{vencimento}}, segue em aberto na {{empresa}}. Se houver algum problema, responda esta mensagem para combinarmos a melhor solução. Para não receber avisos no WhatsApp, responda PARAR.",
};
