import { z } from "zod";

// Contrato canônico do CRM (docs/API_E_INTEGRACOES.md). Adaptadores de sistemas reais convertem para este formato.
export const crmContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  isFinancial: z.boolean().default(false),
});

export const crmCustomerSchema = z.object({
  externalId: z.string().trim().min(1).max(100),
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().max(200).optional(),
  document: z.string().trim().min(1).max(30),
  /** false = registro que NÃO deve existir como cliente (ex.: prospect): nunca importado; se já existia, é arquivado. */
  active: z.boolean().default(true),
  /** situação comercial: só "ativo" é faturável; suspenso/cancelado seguem como clientes (dívidas antigas). */
  status: z.enum(["ativo", "suspenso", "cancelado"]).default("ativo"),
  companyRef: z.string().trim().max(100).optional(), // empresa/CNPJ emissor no CRM (mapeia p/ nossa empresa)
  contacts: z.array(crmContactSchema).max(50).default([]),
  updatedAt: z.string().optional(),
});
export type CrmCustomer = z.infer<typeof crmCustomerSchema>;

/** O adaptador devolve itens crus; o motor valida cada um (payload inválido não derruba a sincronização). */
export type CrmPage = { items: unknown[]; nextCursor?: string };

export interface CrmAdapter {
  /** Somente leitura. Nunca grava no CRM. */
  listCustomers(opts: { cursor?: string; updatedSince?: string }): Promise<CrmPage>;
}

export const MAX_PAGE_ITEMS = 5000;
export const MAX_BODY_BYTES = 2_000_000;

export class CrmError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}
