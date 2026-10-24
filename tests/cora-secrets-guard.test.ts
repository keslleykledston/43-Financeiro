import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Quem pode importar `cora-secrets` (segredos em claro): só o adaptador real da Cora, quando existir (E10b). Hoje, ninguém.
const AUTHORIZED: string[] = [];
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });

describe("segredos do e-mail (SMTP) em claro", () => {
  it("nenhum arquivo de src/ importa email-secrets; a config nunca lê as credenciais em claro", () => {
    const offenders = walk("src").filter((f) => !f.endsWith("email-secrets.ts") && /email-secrets/.test(readFileSync(f, "utf8")));
    expect(offenders.filter((f) => !f.endsWith("email-config.ts"))).toEqual([]); // email-config importa só a função de contexto (emailContext)
    expect(readFileSync("src/modules/providers/email-config.ts", "utf8")).not.toMatch(/readEmailCredentials/);
  });
  it("cliente (use client) nunca importa módulos de credenciais de e-mail", () => {
    for (const f of walk("src").filter((x) => /^["']use client["']/.test(readFileSync(x, "utf8")))) expect(readFileSync(f, "utf8")).not.toMatch(/email-secrets|email-config|secretbox/);
  });
});

describe("segredos da Cora em claro", () => {
  it("nenhum arquivo de src/ (telas, ações, serviços) importa cora-secrets", () => {
    const offenders = walk("src").filter((f) => !f.endsWith("cora-secrets.ts") && /cora-secrets/.test(readFileSync(f, "utf8")) && !AUTHORIZED.includes(f.replace(/\\/g, "/")));
    // cora-config.ts importa só a função de contexto (coraContext), nunca readCoraCredentials
    expect(offenders.filter((f) => !f.endsWith("cora-config.ts"))).toEqual([]);
    expect(readFileSync("src/modules/providers/cora-config.ts", "utf8")).not.toMatch(/readCoraCredentials/);
  });

  it("cliente (use client) nunca importa módulos de credenciais", () => {
    for (const f of walk("src").filter((x) => /^["']use client["']/.test(readFileSync(x, "utf8")))) expect(readFileSync(f, "utf8")).not.toMatch(/cora-secrets|cora-config|secretbox/);
  });
});
