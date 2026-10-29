import { createHash } from "node:crypto";
import { CoraHttpError, CoraNetworkError, type CoraClient, type Invoice } from "./cora-http";
import { IssuanceRetryable, IssuanceTimeout } from "./errors";
import type { BoletoDetails, BoletoInput, BoletoProvider, BoletoResult } from "./types";

/**
 * E10b-1 — adaptador de BOLETO da Cora para o motor de emissão. Traduz o contrato do motor (BoletoProvider) para a API v2 de boletos.
 * Só emite/consulta/cancela boleto; o escopo real (o que a rede deixa passar, produção somente leitura) é imposto por `cora-http.ts`, não aqui.
 *
 * Idempotência: a Cora recebe `Idempotency-Key` UUID. A chave do motor (`boleto:<cobrança>[:gN]`) vira um UUID DETERMINÍSTICO (sha-256), então reenviar a mesma
 * emissão (resposta perdida, processo que caiu) devolve o MESMO boleto em vez de criar outro. A chave do motor também vai no campo `code` do boleto,
 * o que permite achá-lo depois (`find`): a listagem da Cora não filtra por `code`, então buscamos pelo CPF/CNPJ + vencimento e conferimos o `code` no detalhe.
 *
 * Erros (contrato do motor): rede/timeout/5xx → `IssuanceTimeout` ou erro genérico (PODE ter emitido → o motor reconsulta, nunca reemite às cegas);
 * 400/422 → `RangeError` (validação, não adianta repetir); 401/403/429 → `IssuanceRetryable` (nada criado).
 */
export const uuidFromKey = (key: string): string => {
  const h = createHash("sha256").update(`k3g-cora-idem|${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
};
export const codeFromKey = (key: string) => `k3g:${key}`.slice(0, 100);
const MAX_LOOKUPS = 150; // detalhes consultados por reconsulta
const mask = (d: string | null) => (d && d.length >= 10 ? `${d.slice(0, 5)}${"•".repeat(Math.max(4, d.length - 9))}${d.slice(-4)}` : "•••••");

export const statusOf = (s: string): BoletoResult["status"] => (s === "PAID" ? "pago" : s === "CANCELLED" ? "cancelado" : "emitido"); // OPEN, LATE, IN_PAYMENT, DRAFT: ainda não quitado
const toResult = (inv: Invoice): BoletoResult => ({ providerRef: inv.id, status: statusOf(inv.status), digitableLineMasked: mask(inv.digitable) });

/** Traduz erro da Cora para o vocabulário do motor. `op` muda o tratamento de 404/422. */
export function mapCoraError(e: unknown, op: "issue" | "find" | "status" | "cancel"): never {
  if (e instanceof CoraNetworkError) throw new IssuanceTimeout();
  if (e instanceof CoraHttpError) {
    if (e.status === 0) throw new RangeError("bloqueado_localmente"); // a trava local recusou: nada foi enviado
    if (op === "cancel" && e.code === "REC-0006") throw new Error("boleto_pago");
    if (e.status === 404) throw new Error("boleto_inexistente");
    if (e.status === 400 || e.status === 422) throw new RangeError(op === "cancel" ? "erro_provedor" : e.field ?? "validacao_provedor");
    if (e.status === 401 || e.status === 403 || e.status === 429) throw new IssuanceRetryable(e.status === 429 ? "limite_da_cora" : "acesso_negado");
  }
  throw e instanceof Error ? e : new Error("erro_desconhecido"); // 5xx e o resto: resultado desconhecido (o motor reconsulta)
}

/** Pagamentos CONCLUÍDOS (a Cora marca `SUCCESS`); os demais (iniciados/falhos) não contam como dinheiro recebido. */
export const detailsOf = (inv: Invoice): BoletoDetails => ({
  status: statusOf(inv.status), rawStatus: inv.status, totalAmountCents: inv.totalAmountCents, totalPaidCents: inv.totalPaidCents, dueDate: inv.dueDate, paidOn: inv.occurrenceDate,
  payments: inv.payments.filter((p) => p.status === "SUCCESS").map(({ id, method, totalPaidCents, interestCents, fineCents, finalizedAt }) => ({ id, method, totalPaidCents, interestCents, fineCents, finalizedAt })),
  digitable: inv.digitable, barcode: inv.barcode, pdfUrl: inv.pdfUrl, pixEmv: inv.pixEmv, slipRegistered: inv.slipRegistered,
});

/** Teto de um boleto REAL (produção): acima disso, só com decisão humana fora do motor. */
export const LIVE_MAX_CENTS = 5_000_000; // R$ 50.000,00
const MAX_DUP_DETAILS = 20;
const todayManaus = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });

/**
 * `live` = PRODUÇÃO (boletos reais). Antes de emitir: vencimento não pode estar no passado, valor abaixo do teto e ANTI-DUPLICIDADE — se a Cora já tem, para o mesmo CPF/CNPJ e vencimento, um boleto
 * não cancelado de MESMO valor que não seja o nosso (as cobranças também foram/são emitidas à mão pela equipe), NÃO emite: falha com `boleto_ja_existe_na_cora` para revisão humana.
 * Se o boleto achado é o nosso (mesmo `code`, ex.: resposta anterior perdida), devolve-o sem criar outro.
 */
export function createCoraBoletoProvider(client: CoraClient, opts: { live?: boolean } = {}): BoletoProvider {
  return {
    mode: "live",
    async issue(i: BoletoInput) {
      if (!Number.isSafeInteger(i.amountCents) || i.amountCents <= 0) throw new RangeError("valor_invalido");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(i.dueDate)) throw new RangeError("vencimento_invalido");
      if (!i.idempotencyKey) throw new RangeError("idempotency_key_ausente");
      if (!i.customerName.trim()) throw new RangeError("cliente_sem_nome");
      if (opts.live) {
        if (i.dueDate < todayManaus()) throw new RangeError("vencimento_no_passado");
        if (i.amountCents > LIVE_MAX_CENTS) throw new RangeError("valor_acima_do_limite");
        let dupes: Invoice[] = [];
        try {
          for (let page = 1; page <= 3; page++) {
            const l = await client.listInvoices({ search: i.customerDocument, start: i.dueDate, end: i.dueDate, page, perPage: 100 });
            dupes = dupes.concat(l.items.filter((x) => x.status !== "CANCELLED" && x.totalAmountCents === i.amountCents));
            if (l.items.length < 100) break;
            if (page === 3) throw new Error("busca_incompleta");
          }
          if (dupes.length > MAX_DUP_DETAILS) throw new Error("busca_incompleta");
          for (const d of dupes) {
            const full = await client.getInvoice(d.id);
            if (full.code === codeFromKey(i.idempotencyKey)) return toResult(full); // é o nosso (emissão anterior): idempotente
          }
        } catch (e) { return mapCoraError(e, "find"); }
        if (dupes.length > 0) throw new RangeError("boleto_ja_existe_na_cora"); // já existe um igual que não é nosso: revisão humana
      }
      let inv: Invoice;
      try {
        inv = await client.createInvoice({
          idempotencyKey: uuidFromKey(i.idempotencyKey), code: codeFromKey(i.idempotencyKey), amountCents: i.amountCents, dueDate: i.dueDate,
          customerName: i.customerName.trim().slice(0, 100), customerDocument: i.customerDocument, description: (i.instructions?.trim() || "Serviços prestados").slice(0, 250),
        });
      } catch (e) {
        if (e instanceof RangeError) throw new RangeError(/documento/i.test(e.message) ? "documento_invalido" : /mínimo/i.test(e.message) ? "valor_minimo" : "validacao_local");
        return mapCoraError(e, "issue");
      }
      if (!inv.id) throw new Error("resposta_sem_id");
      if (inv.totalAmountCents !== i.amountCents) throw new RangeError("valor_divergente"); // o boleto existe na Cora com outro valor: revisão humana, nunca "emitido"
      if (inv.status === "CANCELLED") throw new RangeError("boleto_cancelado"); // mesma chave de um boleto já cancelado lá
      return toResult(inv);
    },

    async find(key: string, ctx?: { customerDocument: string; dueDate: string }) {
      if (!ctx || !/^\d{4}-\d{2}-\d{2}$/.test(ctx.dueDate)) return null;
      const code = codeFromKey(key);
      try {
        let looked = 0;
        for (let page = 1; page <= 3; page++) {
          const l = await client.listInvoices({ search: ctx.customerDocument, start: ctx.dueDate, end: ctx.dueDate, page, perPage: 100 });
          for (const it of l.items) { // cada candidato exige o detalhe (a lista não traz `code`)
            if (it.status === "CANCELLED") continue;
            if (++looked > MAX_LOOKUPS) throw new Error("busca_incompleta"); // não dá para afirmar que NÃO existe: o motor trata como desconhecido (repete a reconsulta), nunca reemite
            const d = await client.getInvoice(it.id);
            if (d.code === code) return toResult(d);
          }
          if (l.items.length < 100) return null;
        }
        throw new Error("busca_incompleta"); // mais de 300 boletos do mesmo cliente no mesmo vencimento: revisão humana
      } catch (e) { return mapCoraError(e, "find"); }
    },

    async status(ref: string) {
      try { return statusOf((await client.getInvoice(ref)).status); } catch (e) { return mapCoraError(e, "status"); }
    },

    async ping() {
      try { await client.accessToken(); } catch (e) { return mapCoraError(e, "status"); }
    },

    async details(ref: string) {
      try { return detailsOf(await client.getInvoice(ref)); } catch (e) { return mapCoraError(e, "status"); }
    },

    async cancel(ref: string) {
      try { await client.cancelInvoice(ref); } catch (e) { return mapCoraError(e, "cancel"); }
    },
  };
}
