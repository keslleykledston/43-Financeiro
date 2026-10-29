import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Quem pode importar `cora-secrets` (segredos em claro): só o cliente HTTP da Cora (cora-http.ts, E10b).
const AUTHORIZED: string[] = ["src/modules/providers/cora-http.ts"];
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });

describe("segredos do e-mail (SMTP) em claro", () => {
  it("nenhum arquivo de src/ importa email-secrets; a config nunca lê as credenciais em claro", () => {
    const offenders = walk("src").filter((f) => !f.endsWith("email-secrets.ts") && /email-secrets/.test(readFileSync(f, "utf8")));
    // email-config importa só a função de contexto (emailContext); email-live.ts é o ÚNICO autorizado a ler a conta em claro (adaptador real, E23)
    expect(offenders.filter((f) => !f.endsWith("email-config.ts") && !f.endsWith("email-live.ts"))).toEqual([]);
    expect(readFileSync("src/modules/providers/email-config.ts", "utf8")).not.toMatch(/readEmailCredentials/);
  });
  it("cliente (use client) nunca importa módulos de credenciais de e-mail", () => {
    for (const f of walk("src").filter((x) => /^["']use client["']/.test(readFileSync(x, "utf8")))) expect(readFileSync(f, "utf8")).not.toMatch(/email-secrets|email-config|secretbox/);
  });
});

describe("escrita em PRODUÇÃO da Cora (E10b-6)", () => {
  it("`liveWrites: true` só aparece no registro de provedores e no cadastro de webhook (que ainda exigem a chave do servidor); nenhuma tela/ação liga", () => {
    const users = walk("src").filter((f) => /liveWrites:\s*(true|prod|env\s*===)/.test(readFileSync(f, "utf8")) || /liveWrites:\s*[a-z]/.test(readFileSync(f, "utf8")));
    const allowed = ["src/modules/providers/registry.ts", "src/modules/issuance/webhooks.ts", "src/modules/providers/cora-http.ts"];
    expect(users.map((f) => f.replace(/\\/g, "/")).filter((f) => !allowed.includes(f))).toEqual([]);
  });
  it("a chave do servidor só é definida no compose (decisão do dono, com commit) e nenhum arquivo de src/ a liga", () => {
    expect(readFileSync("docker-compose.yml", "utf8")).toMatch(/^\s*CORA_PROD_EMISSION_ENABLED:\s*"(true|false)"\s*$/m);
    expect(walk("src").filter((f) => /env\.CORA_PROD_EMISSION_ENABLED\s*=[^=]/.test(readFileSync(f, "utf8")))).toEqual([]);
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
