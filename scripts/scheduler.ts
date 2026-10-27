import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

/**
 * Agendador (E09). A cada ciclo processa a fila das empresas com "envio automático" ligado, respeitando janela, pausa e limites.
 * Provedores SIMULADOS: nada sai do sistema. Log só com contagens (sem nomes, e-mails ou textos).
 */
async function main() {
  const { db } = await import("../src/lib/db");
  const { tickAll } = await import("../src/modules/messaging/service");
  const { applyDueAmendments } = await import("../src/modules/contracts/service");
  const every = Math.max(15, Number(process.env.SCHEDULER_INTERVAL_SECONDS ?? 60)) * 1000;
  let stop = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stop = true; });
  const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
  log({ event: "scheduler.start", everySeconds: every / 1000 });
  while (!stop) {
    try { const n = await applyDueAmendments(db, null); if (n > 0) log({ event: "scheduler.amendments_applied", count: n }); } catch (e) { log({ event: "scheduler.amendments_error", kind: (e as Error).name }); }
    try {
      const res = await tickAll(db);
      const sum = res.reduce((a, r) => ({ processed: a.processed + (r.result?.processed ?? 0), failed: a.failed + (r.result?.failed ?? 0), errors: a.errors + (r.error ? 1 : 0) }), { processed: 0, failed: 0, errors: 0 });
      if (sum.processed + sum.failed + sum.errors > 0) log({ event: "scheduler.tick", companies: res.length, ...sum, errorKinds: res.filter((r) => r.error).map((r) => r.error) });
    } catch (e) { log({ event: "scheduler.error", kind: (e as Error).name }); }
    for (let waited = 0; waited < every && !stop; waited += 1000) await new Promise((r) => setTimeout(r, 1000));
  }
  log({ event: "scheduler.stop" });
  process.exit(0);
}
main().catch((e) => { console.error("scheduler fatal:", (e as Error).name); process.exit(1); });
