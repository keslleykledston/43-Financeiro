// SIMULAÇÃO só de contagens: roda o conector real + motor de plano contra o CRM com o banco VAZIO. Não grava nada,
// não imprime nome/documento/e-mail/token. Uso: docker compose --profile tools run --rm tools pnpm crm:plan
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { getCrmAdapter } from "../src/modules/integrations/crm/factory";
import { buildPlan } from "../src/modules/integrations/crm/sync";
import { mapK3gCompany } from "../src/modules/integrations/crm/k3g";
import { parseDocument } from "../src/lib/validators/document";

(async () => {
  const adapter = getCrmAdapter();
  const page = await adapter.listCustomers({});
  const raw = page.items;
  const plan = buildPlan([], new Set(), raw);
  console.log("Plano para uma empresa SEM clientes ainda (simulação; nada foi gravado):");
  console.log(JSON.stringify(plan.stats));
  const mapped = raw as { active?: boolean; document?: string }[];
  const activeItems = mapped.filter((m) => m.active);
  const activeValid = activeItems.filter((m) => m.document && parseDocument(m.document));
  console.log(`clientes no CRM (ativo+suspenso+cancelado): ${activeItems.length}; com CNPJ válido: ${activeValid.length}; sem CNPJ válido (ficariam de fora): ${activeItems.length - activeValid.length}`);
  console.log(`conflitos internos do CRM (mesmo CNPJ em 2 cadastros): ${plan.conflicts.length}`);
})().catch((e) => { console.error("falha:", (e as Error).name, (e as Error).message?.slice(0, 160)); process.exit(1); });
