import { and, desc, eq, gte, inArray, isNull, like, lt, or } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, memberships, users } from "@/lib/db/schema";
import { Invalid, requirePerm } from "./service";

export const AUDIT_PAGE_SIZE = 50;
const MAX_PAGE = 200;

/** Nomes legíveis dos eventos mais comuns; o resto aparece pelo código. */
export const ACTION_LABEL: Record<string, string> = {
  "auth.login.ok": "Entrou no sistema", "auth.login.failed": "Tentativa de login recusada", "auth.password_changed": "Trocou a senha",
  "auth.password_change.failed": "Troca de senha recusada", "auth.sessions_revoked": "Encerrou todas as sessões",
  "member.invited": "Convidou usuário", "member.joined": "Aceitou convite", "member.removed": "Removeu usuário",
  "contract.created": "Criou contrato", "contract.imported": "Importou contratos", "contract.import_approved": "Aprovou lote de contratos", "contract.import_rejected": "Rejeitou lote de contratos",
  "billing.batch.generated": "Gerou lote de cobrança", "billing.batch.approved": "Aprovou lote de cobrança",
  "receivable.payment_registered": "Registrou pagamento recebido", "receivable.payment_reversed": "Estornou pagamento recebido",
  "bank.import.applied": "Aplicou extrato bancário", "bank.allocated": "Conciliou lançamento", "bank.allocation_undone": "Desfez conciliação",
  "boleto.cancel_requested": "Pediu cancelamento de boleto", "boleto.cancelled": "Boleto cancelado", "boleto.cancel_failed": "Cancelamento de boleto recusado", "boleto.cancel_unknown": "Cancelamento de boleto sem resposta", "boleto.cancel_rechecked": "Reconsultou cancelamento de boleto", "boleto.paid_at_provider": "Provedor informou boleto pago",
  "commission.contract_set": "Definiu comissão de parceiro no contrato", "commission.closed": "Fechou comissão do mês", "commission.paid": "Registrou pagamento de comissão", "commission.cancelled": "Cancelou fechamento de comissão",
  "provider.credentials_saved": "Guardou credenciais de provedor", "provider.credentials_removed": "Removeu credenciais de provedor",
  "contract.change_proposed": "Propôs aditivo/alteração de contrato", "contract.version_approved": "Aprovou aditivo/alteração de contrato", "contract.version_rejected": "Rejeitou alteração de contrato", "contract.draft_updated": "Corrigiu contrato em rascunho", "contract.status_changed": "Mudou a situação do contrato",
  "note.added": "Registrou comentário", "company.updated": "Alterou dados da empresa", "company.fiscal_updated": "Alterou dados fiscais/contabilidade da empresa", "email.live_authorized": "Autorizou envio real de e-mail (canário)", "email.live_revoked": "Revogou autorização de envio real de e-mail", "email.test_sent": "Enviou e-mail de teste", "email.test_failed": "E-mail de teste não enviado", "messages.email.live_run": "Processou fila com e-mail REAL", "provider.email_saved": "Guardou conta de e-mail (SMTP)", "provider.email_removed": "Removeu conta de e-mail (SMTP)",
  "party.created": "Criou cadastro", "party.updated": "Alterou cadastro", "party.archived": "Arquivou cadastro",
};

// segredos e dados pessoais (e-mail, telefone, documento, nome) nunca vão para a tela, mesmo que algum evento os grave
const SECRET_KEY = /pass|senha|token|secret|segredo|hash|key|chave|cookie|mail|fone|phone|cpf|cnpj|document|nome|name/i;

/** Resumo curto do detalhe (já gravado só com ids/contagens); mesmo assim esconde qualquer chave com cara de segredo ou dado pessoal e limita o tamanho. */
export function summarizeDetail(detail: unknown): string {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return "";
  const parts = Object.entries(detail as Record<string, unknown>).map(([k, v]) => {
    if (SECRET_KEY.test(k)) return `${k}: ••••`;
    if (v === null || v === undefined) return null;
    if (typeof v === "object") return `${k}: …`;
    return `${k}: ${String(v)}`;
  }).filter((x): x is string => !!x);
  const out = parts.join(" · ");
  return out.length > 160 ? out.slice(0, 157) + "…" : out;
}

export type AuditFilter = { action?: string; actorId?: string; from?: string; to?: string; page?: number };
const isDay = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Trilha da empresa: eventos com company_id dela + eventos de conta (login, senha, sessões) de quem é membro ativo dela. */
export async function listAudit(db: DB, actorUserId: string, companyId: string, f: AuditFilter = {}) {
  await requirePerm(db, actorUserId, companyId, "audit.read");
  if ((f.from && !isDay(f.from)) || (f.to && !isDay(f.to))) throw new Invalid("Data inválida");
  const page = Math.min(Math.max(Math.trunc(f.page ?? 1) || 1, 1), MAX_PAGE);
  const members = db.select({ id: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, companyId), eq(memberships.status, "active")));
  const where = and(
    or(eq(auditLog.companyId, companyId), and(isNull(auditLog.companyId), inArray(auditLog.actorId, members))),
    f.action?.trim() ? like(auditLog.action, `${f.action.trim().replace(/[%_\\]/g, "\\$&").slice(0, 60)}%`) : undefined,
    f.actorId ? eq(auditLog.actorId, f.actorId) : undefined,
    f.from ? gte(auditLog.createdAt, new Date(`${f.from}T00:00:00-04:00`)) : undefined, // dia em America/Manaus (UTC-4)
    f.to ? lt(auditLog.createdAt, new Date(new Date(`${f.to}T00:00:00-04:00`).getTime() + 86_400_000)) : undefined,
  );
  const rows = await db
    .select({ id: auditLog.id, at: auditLog.createdAt, action: auditLog.action, detail: auditLog.detail, actorId: auditLog.actorId, actorName: users.name, actorEmail: users.email })
    .from(auditLog).leftJoin(users, eq(users.id, auditLog.actorId)).where(where)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(AUDIT_PAGE_SIZE + 1).offset((page - 1) * AUDIT_PAGE_SIZE);
  return {
    page, hasNext: rows.length > AUDIT_PAGE_SIZE,
    rows: rows.slice(0, AUDIT_PAGE_SIZE).map((r) => ({ id: r.id, at: r.at, action: r.action, label: ACTION_LABEL[r.action] ?? r.action, who: r.actorName ?? r.actorEmail ?? "sistema", summary: summarizeDetail(r.detail) })),
  };
}

export async function listAuditActors(db: DB, actorUserId: string, companyId: string) {
  await requirePerm(db, actorUserId, companyId, "audit.read");
  return db.select({ id: users.id, name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.status, "active"))).orderBy(users.name);
}
