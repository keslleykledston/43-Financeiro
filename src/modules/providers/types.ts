/**
 * E09 — PORTAS (interfaces) dos provedores externos. Hoje só existem implementações SIMULADAS (mock.ts).
 * Os adaptadores reais (E10) implementam estas mesmas interfaces, um provedor por vez, só após homologação,
 * credenciais fora do Git e autorização explícita. Nada aqui faz chamada de rede.
 */
export type SendResult = { ok: true; providerRef: string } | { ok: false; retryable: boolean; error: string };

export interface EmailProvider {
  readonly mode: "mock" | "live";
  send(m: { to: string[]; subject: string; text: string; html: string; idempotencyKey: string }): Promise<SendResult>;
}
export interface WhatsappProvider {
  readonly mode: "mock" | "live";
  send(m: { to: string; text: string; idempotencyKey: string }): Promise<SendResult>;
}

export type BoletoInput = { idempotencyKey: string; amountCents: number; dueDate: string; customerName: string; customerDocument: string };
export type BoletoResult = { providerRef: string; status: "emitido" | "pago" | "cancelado"; digitableLineMasked: string };
export interface BoletoProvider { // Cora (boletos v2)
  readonly mode: "mock" | "live";
  issue(i: BoletoInput): Promise<BoletoResult>;
  status(ref: string): Promise<BoletoResult["status"]>;
  cancel(ref: string): Promise<void>;
}

export type StatementLine = { externalId: string; date: string; amountCents: number; description: string };
export interface StatementProvider { // Cora (extrato)
  readonly mode: "mock" | "live";
  list(from: string, to: string): Promise<StatementLine[]>;
}

export type NfseInput = { idempotencyKey: string; amountCents: number; competence: string; customerName: string; customerDocument: string; description: string };
export interface NfseProvider { // NFS-e da Cora (beta)
  readonly mode: "mock" | "live";
  issue(i: NfseInput): Promise<{ providerRef: string; status: "processando" | "emitida" | "rejeitada" }>;
  status(ref: string): Promise<"processando" | "emitida" | "rejeitada">;
}

export type Providers = { email: EmailProvider; whatsapp: WhatsappProvider; boleto: BoletoProvider; statement: StatementProvider; nfse: NfseProvider };
