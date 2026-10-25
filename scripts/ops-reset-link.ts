/**
 * E27 — link de nova senha gerado NO SERVIDOR, para quem ficou sem acesso e ninguém consegue gerar pela tela (ex.: único admin técnico).
 * O link é um segredo: vai para um ARQUIVO privado (0600), nunca para a tela/conversa/Git.
 *   OPS_EMAIL=pessoa@empresa.com OPS_OUT=/caminho/privado/link.txt OPS_CONFIRM=sim docker compose --profile tools run --rm -v /caminho/privado:/out tools pnpm tsx scripts/ops-reset-link.ts
 * Vale por 2 horas, uso único. Auditado como "auth.reset_link_ops".
 */
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { db } from "../src/lib/db";
import { issueResetLinkForOps } from "../src/modules/identity/recovery";

(async () => {
  const email = process.env.OPS_EMAIL, out = process.env.OPS_OUT;
  if (!email || !out) throw new Error("Informe OPS_EMAIL e OPS_OUT (arquivo privado)");
  if (process.env.OPS_CONFIRM !== "sim") throw new Error("Confirme com OPS_CONFIRM=sim");
  // abre ANTES de gerar o link: "wx" recusa arquivo existente (inclusive symlink) e já nasce 0600, sem janela legível
  const fd = openSync(out, "wx", 0o600);
  try {
    const link = await issueResetLinkForOps(db, email, process.env.AUTH_URL ?? "");
    writeSync(fd, link + "\n");
  } catch (e) { closeSync(fd); unlinkSync(out); throw e; } // falhou: não deixa arquivo vazio
  closeSync(fd);
  console.log(`Link gravado em ${out} (vale 2 horas, uso único). Não foi exibido na tela.`);
  process.exit(0);
})().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
