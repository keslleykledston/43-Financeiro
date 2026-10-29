import { eq, sql } from "drizzle-orm";
import { centsFromNumeric } from "@/lib/money";
import type { DB } from "@/lib/db";
import { issuanceSettings } from "@/lib/db/schema";
import { MAX_ATTACHMENT_BYTES } from "@/modules/providers/smtp";
import { safePdfUrl } from "@/modules/issuance/boleto-details";
import { resolveProvidersForMode } from "@/modules/providers/registry";
import type { Providers } from "@/modules/providers/types";

/**
 * E33 — dados do BOLETO para as mensagens (e-mail/WhatsApp). Só LEITURA: consulta o boleto na Cora (como "Ver dados do boleto") no momento do envio; nada é guardado além do texto final da mensagem.
 *  - `ok`: boleto emitido e em aberto → linha digitável + PDF.
 *  - `none`: não há boleto ativo (não emitido, pago ou cancelado) → a mensagem ESPERA (empresa com provedor real) ou segue sem boleto.
 *  - `indisponivel`: a Cora não respondeu agora → a mensagem espera e tenta na próxima rodada.
 *  - `simulado`: boleto de mentira (provedor simulado): o texto mostra "(boleto simulado)"; e-mail REAL com boleto simulado é bloqueado pelo caminho real.
 */
export type BoletoMail = { state: "ok" | "none" | "simulado" | "indisponivel"; digitable: string | null; pdfUrl: string | null };
export const SIMULATED_LINE = "(boleto simulado)";
export const NONE: BoletoMail = { state: "none", digitable: null, pdfUrl: null };
const MAX_LOOKUPS = 60; // consultas à Cora por rodada

export type BoletoMode = "simulado" | "cora_homologacao" | "cora_producao";
/** Provedor de boleto configurado na empresa (decide se a mensagem precisa esperar o boleto). */
export async function companyBoletoMode(db: DB, companyId: string): Promise<BoletoMode> {
  const [r] = await db.select({ p: issuanceSettings.boletoProvider }).from(issuanceSettings).where(eq(issuanceSettings.companyId, companyId));
  return r?.p === "cora_producao" || r?.p === "cora_homologacao" ? r.p : "simulado";
}

export async function prefetchBoletoMail(db: DB, companyId: string, chargeIds: string[], providers?: Providers): Promise<Map<string, BoletoMail>> {
  const out = new Map<string, BoletoMail>();
  const ids = [...new Set(chargeIds)].filter((i) => /^[0-9a-f-]{36}$/i.test(i)).slice(0, 500);
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`select distinct on (r.charge_id) r.charge_id::text as charge_id, r.mode, r.external_ref as ref, ch.amount::text as amount, ch.due_date::text as due
    from issuance_requests r join charges ch on ch.id = r.charge_id and ch.company_id = r.company_id
    where r.company_id = ${companyId} and r.kind = 'boleto' and r.status = 'emitido' and r.charge_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) order by r.charge_id, r.created_at desc`)) as unknown as { charge_id: string; mode: string; ref: string | null; amount: string; due: string }[];
  const provs = new Map<string, Providers | null>();
  let lookups = 0;
  for (const r of rows) {
    if (r.mode === "simulado") { out.set(r.charge_id, { state: "simulado", digitable: null, pdfUrl: null }); continue; }
    if (!r.ref) continue;
    if (!provs.has(r.mode)) provs.set(r.mode, await resolveProvidersForMode(db, companyId, r.mode, providers).catch(() => null));
    const p = provs.get(r.mode);
    if (!p || ++lookups > MAX_LOOKUPS) { out.set(r.charge_id, { state: "indisponivel", digitable: null, pdfUrl: null }); continue; }
    try {
      const d = await p.boleto.details(r.ref);
      if (d.status !== "emitido") { out.set(r.charge_id, NONE); continue; } // pago/cancelado: sem boleto para enviar
      // O boleto precisa ser O DA COBRANÇA (valor e vencimento iguais), ter linha digitável e PDF de origem permitida; senão a mensagem espera e ninguém recebe boleto errado ou incompleto
      const pdf = safePdfUrl(d.pdfUrl);
      const same = d.totalAmountCents === centsFromNumeric(r.amount) && d.dueDate === r.due;
      out.set(r.charge_id, same && d.digitable && pdf ? { state: "ok", digitable: d.digitable, pdfUrl: pdf } : { state: "indisponivel", digitable: null, pdfUrl: null });
    } catch { out.set(r.charge_id, { state: "indisponivel", digitable: null, pdfUrl: null }); }
  }
  return out;
}

// Injeção só sob o executor de testes (como o transporte falso da Cora).
let testFetcher: typeof fetch | undefined;
export function __setPdfFetcherForTests(f: typeof fetch | undefined) { if (process.env.VITEST !== "true") throw new Error("Injeção proibida fora dos testes"); testFetcher = f; }

/** Baixa o PDF do boleto (só de origem da Cora, https, sem redirecionamento, até 3 MB, assinatura %PDF). Qualquer desvio lança. `fetcher` só é honrado sob o executor de testes. */
export async function fetchBoletoPdf(url: string, fetcher?: typeof fetch): Promise<Buffer> {
  const safe = safePdfUrl(url);
  if (!safe) throw new Error("pdf_origem_nao_permitida");
  const f = process.env.VITEST === "true" ? (fetcher ?? testFetcher ?? fetch) : fetch;
  const res = await f(safe, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { accept: "application/pdf" } });
  if (res.status !== 200 || !res.body) throw new Error(`pdf_http_${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_ATTACHMENT_BYTES) throw new Error("pdf_grande_demais");
  const chunks: Buffer[] = []; let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ATTACHMENT_BYTES) { await reader.cancel(); throw new Error("pdf_grande_demais"); }
    chunks.push(Buffer.from(value));
  }
  const buf = Buffer.concat(chunks);
  if (buf.length < 100 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("pdf_invalido");
  return buf;
}
