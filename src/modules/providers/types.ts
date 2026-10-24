/**
 * E09 — PORTAS (interfaces) dos provedores externos. Hoje só existem implementações SIMULADAS (mock.ts).
 * Os adaptadores reais (E10) implementam estas mesmas interfaces, um provedor por vez, só após homologação,
 * credenciais fora do Git e autorização explícita. Nada aqui faz chamada de rede.
 */
/** `unknown: true` = o envio PODE ter acontecido (queda depois de enviar o conteúdo): nunca reenviar sozinho, só revisão humana. */
export type SendResult = { ok: true; providerRef: string } | { ok: false; retryable: boolean; error: string; unknown?: boolean };

export interface EmailProvider {
  readonly mode: "mock" | "live";
  send(m: { to: string[]; subject: string; text: string; html: string; idempotencyKey: string }): Promise<SendResult>;
}
export interface WhatsappProvider {
  readonly mode: "mock" | "live";
  send(m: { to: string; text: string; idempotencyKey: string }): Promise<SendResult>;
}

export type BoletoInput = { idempotencyKey: string; amountCents: number; dueDate: string; customerName: string; customerDocument: string; /** texto/instruções do boleto deste cliente (E26), já com os campos preenchidos */ instructions?: string };
export type BoletoResult = { providerRef: string; status: "emitido" | "pago" | "cancelado"; digitableLineMasked: string };
/** Cora: SOMENTE boletos (emitir, consultar situação, segunda via e cancelar — o cancelamento só pela diretoria, com motivo e registro). Sem pagamento, transferência, saldo/extrato (escopo do dono, 2026-10-24; ver CORA_SCOPE e ADR-017). */
export interface BoletoProvider { // Cora (boletos v2)
  readonly mode: "mock" | "live";
  issue(i: BoletoInput): Promise<BoletoResult>;
  /** Reconsulta por chave de idempotência: já existe? (usada quando a resposta da emissão se perdeu). null = não existe. */
  find(idempotencyKey: string): Promise<BoletoResult | null>;
  status(ref: string): Promise<BoletoResult["status"]>;
  /** Cancela um boleto EMITIDO e ainda sem pagamento. Só é chamado pelo fluxo de cancelamento da diretoria (E20). */
  cancel(ref: string): Promise<void>;
}

export type NfseAddress = { cep: string | null; street: string | null; number: string | null; complement: string | null; district: string | null; city: string | null; cityIbge: string | null; uf: string | null };
/** `description` = texto da nota do cliente (E26) ou, sem ele, a descrição do contrato. `customerAddress` = endereço do tomador cadastrado no cliente. */
export type NfseInput = { idempotencyKey: string; amountCents: number; competence: string; customerName: string; customerDocument: string; description: string; customerAddress?: NfseAddress };
export interface NfseProvider { // NFS-e da Cora (beta)
  readonly mode: "mock" | "live";
  issue(i: NfseInput): Promise<{ providerRef: string; status: "processando" | "emitida" | "rejeitada" }>;
  find(idempotencyKey: string): Promise<{ providerRef: string; status: "processando" | "emitida" | "rejeitada" } | null>;
  status(ref: string): Promise<"processando" | "emitida" | "rejeitada">;
}

export type Providers = { email: EmailProvider; whatsapp: WhatsappProvider; boleto: BoletoProvider; nfse: NfseProvider };
