// E10b — sonda da Cora. Produção é SOMENTE LEITURA (token + coleta); a emissão de teste só roda em homologação (stage). Sem pagamento, sem transferência: o cliente (cora-http.ts) recusa qualquer rota fora de token/boletos.
// Etapas: 1) token (valida o certificado mTLS)  2) coleta (lista boletos, só leitura)  3) opcional OPS_CORA_CREATE=1 (apenas OPS_CORA_ENV=homologacao): emite UM boleto de teste de R$ 5,00 em stage
//   (cliente fictício) enviando a MESMA Idempotency-Key duas vezes para provar que a Cora não duplica, e reconsulta pelo id.
// Uso: docker compose --profile tools run --rm -e OPS_CORA_CREATE tools pnpm tsx scripts/ops-cora-probe.ts
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const cpf = () => { // CPF fictício com dígitos verificadores válidos
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (a: number[]) => { const s = a.reduce((t, n, i) => t + n * (a.length + 1 - i), 0) % 11; return s < 2 ? 0 : 11 - s; };
  d.push(dv(d)); d.push(dv(d));
  return d.join("");
};
const iso = (dt: Date) => dt.toISOString().slice(0, 10);

(async () => {
  const { db } = await import("../src/lib/db");
  const { sql } = await import("drizzle-orm");
  const { coraClientFor, newIdempotencyKey, CoraHttpError } = await import("../src/modules/providers/cora-http");
  const env = (process.env.OPS_CORA_ENV ?? "producao") as "homologacao" | "producao";
  if (!["homologacao", "producao"].includes(env)) throw new Error("OPS_CORA_ENV inválido");
  const rows = await db.execute(sql`select p.company_id as id, c.name from provider_credentials p join companies c on c.id = p.company_id where p.provider = 'cora' and p.environment = ${env}`) as unknown as { id: string; name: string }[];
  if (!rows.length) throw new Error("Nenhuma credencial Cora cadastrada neste ambiente");
  for (const r of rows) {
    console.log(`\n== ${r.name} (${env}) ==`);
    const cli = await coraClientFor(db, r.id, env);
    try {
      const t = await cli.accessToken();
      console.log(`1) token OK (mTLS aceito; validade ${Math.round(t.expiresInSec / 3600)} h)`);
      const l = await cli.listInvoices({ perPage: 20 });
      const hist: Record<string, number> = {};
      for (const i of l.items) hist[i.status] = (hist[i.status] ?? 0) + 1;
      console.log(`2) coleta OK: ${l.items.length} boleto(s) na página (total informado: ${l.totalItems ?? "n/d"}); situações: ${JSON.stringify(hist)}`);
      for (const i of l.items.slice(0, 5)) console.log(`   - ${i.id} ${i.status} R$ ${(i.totalAmountCents / 100).toFixed(2)} venc ${i.dueDate ?? "-"}`);
      if (process.env.OPS_CORA_CREATE === "1" && env === "homologacao") {
        const key = newIdempotencyKey();
        const due = new Date(Date.now() + 10 * 86_400_000);
        const input = { idempotencyKey: key, code: `probe-${key.slice(0, 8)}`, amountCents: 500, dueDate: iso(due), customerName: "TESTE K3G Finance (homologacao)", customerDocument: cpf(), description: "Teste de homologacao K3G Finance - ignorar" };
        const a = await cli.createInvoice(input);
        console.log(`3) emissão OK em stage: ${a.id} ${a.status} R$ ${(a.totalAmountCents / 100).toFixed(2)} venc ${a.dueDate}; linha digitável ${a.digitable ? "presente" : "ausente"}; PDF ${a.pdfUrl ? "presente" : "ausente"}`);
        const b = await cli.createInvoice(input);
        console.log(`   idempotência: mesma chave reenviada → ${b.id === a.id ? "MESMO boleto (sem duplicar)" : "ATENÇÃO: boleto DIFERENTE (" + b.id + ")"}`);
        const g = await cli.getInvoice(a.id);
        console.log(`   reconsulta por id: ${g.id} ${g.status}`);
      }
    } catch (e) {
      if (e instanceof CoraHttpError) console.log(`FALHA (${e.status}${e.code ? " " + e.code : ""}): ${e.message}`);
      else console.log(`FALHA: ${(e as Error).name}: ${(e as Error).message}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).message); process.exit(1); });
