import { createHash } from "node:crypto";
import type { BoletoResult, Providers, SendResult } from "./types";

/** Provedores SIMULADOS: determinísticos, idempotentes por chave, sem rede, sem efeito fora do processo. */
const ref = (kind: string, key: string) => `mock-${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
const MARK_FAIL = "falha.test", MARK_INVALID = "invalido.test"; // destinatários de teste que simulam erro temporário / definitivo

function sendResult(kind: string, to: string, key: string): SendResult {
  if (!key) return { ok: false, retryable: false, error: "idempotency_key_ausente" };
  if (to.includes(MARK_INVALID)) return { ok: false, retryable: false, error: "destinatario_invalido" };
  if (to.includes(MARK_FAIL)) return { ok: false, retryable: true, error: "falha_temporaria" };
  return { ok: true, providerRef: ref(kind, key) };
}

export function createMockProviders(): Providers {
  const boletos = new Map<string, BoletoResult["status"]>();
  const byKey = new Map<string, string>(); // chave de idempotência → referência (boleto e NFS-e)
  const nfse = new Map<string, "processando" | "emitida" | "rejeitada">();
  return {
    email: { mode: "mock", send: async (m) => (m.to.length === 0 ? { ok: false, retryable: false, error: "sem_destinatario" } : sendResult("email", m.to.join(","), m.idempotencyKey)) },
    whatsapp: { mode: "mock", send: async (m) => sendResult("wa", m.to, m.idempotencyKey) },
    boleto: {
      mode: "mock",
      async issue(i) {
        if (!Number.isSafeInteger(i.amountCents) || i.amountCents <= 0) throw new RangeError("valor_invalido");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(i.dueDate)) throw new RangeError("vencimento_invalido");
        if (!i.idempotencyKey) throw new RangeError("idempotency_key_ausente");
        const r = ref("boleto", i.idempotencyKey);
        if (!boletos.has(r)) boletos.set(r, "emitido");
        byKey.set(`boleto:${i.idempotencyKey}`, r);
        return { providerRef: r, status: boletos.get(r)!, digitableLineMasked: "00000.00000 •••••.••••• •••••.••••• 0 00000000000000" };
      },
      async find(key) { const r = byKey.get(`boleto:${key}`); return r ? { providerRef: r, status: boletos.get(r)!, digitableLineMasked: "00000.00000 •••••.••••• •••••.••••• 0 00000000000000" } : null; },
      async status(r) { const s = boletos.get(r); if (!s) throw new Error("boleto_inexistente"); return s; },
      async cancel(r) { if (!boletos.has(r)) throw new Error("boleto_inexistente"); boletos.set(r, "cancelado"); },
    },
    statement: {
      mode: "mock",
      async list(from, to) {
        if (from > to) throw new RangeError("periodo_invalido");
        return [{ externalId: ref("stmt", `${from}|${to}`), date: from, amountCents: 100000, description: "EXTRATO SIMULADO" }];
      },
    },
    nfse: {
      mode: "mock",
      async issue(i) {
        if (!Number.isSafeInteger(i.amountCents) || i.amountCents <= 0) throw new RangeError("valor_invalido");
        if (!i.idempotencyKey) throw new RangeError("idempotency_key_ausente");
        const r = ref("nfse", i.idempotencyKey);
        if (!nfse.has(r)) nfse.set(r, "processando");
        byKey.set(`nfse:${i.idempotencyKey}`, r);
        return { providerRef: r, status: nfse.get(r)! };
      },
      async find(key) { const r = byKey.get(`nfse:${key}`); return r ? { providerRef: r, status: nfse.get(r)! } : null; },
      async status(r) { const s = nfse.get(r); if (!s) throw new Error("nfse_inexistente"); if (s === "processando") nfse.set(r, "emitida"); return nfse.get(r)!; }, // beta: confirmação assíncrona (reconsulta)
    },
  };
}
