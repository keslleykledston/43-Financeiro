import { and, eq } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, emailAccounts, issuanceSettings, whatsappCompanySettings } from "@/lib/db/schema";
import { Invalid, activeRole, requirePerm } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { LIVE_CONFIRM_PHRASE, LiveNotAvailable, prodEmissionOn } from "@/modules/providers/registry";
import { cancelPendingBoletos, openBoletoRequests, saveIssuanceSettings } from "@/modules/issuance/service";
import { activeAuthorization, flagOn, sentToday } from "@/modules/providers/email-live";
import { authorizeEmailLive, revokeEmailLive } from "@/modules/providers/email-auth";
import { ALLOW_ALL } from "@/modules/providers/smtp";
import { SEND_PHRASE, saveCompanySettings } from "@/modules/whatsapp/outbound";
import { AUTO_PHRASE, saveAutomation } from "@/modules/whatsapp/regua";
import { automationOn, sendOn } from "@/modules/whatsapp/service";
import { CAPS } from "@/modules/whatsapp/domain";

/**
 * A1 — painel ÚNICO de autorizações: uma chave liga/desliga por função (boletos reais, e-mail a clientes, WhatsApp, régua de WhatsApp). Só a diretoria (a permissão de cada função) liga ou desliga;
 * os demais papéis só VEEM o estado. Quem liga e quando ficam na auditoria (é a autorização registrada), sem frase, referência ou lista para digitar.
 * Cada chave delega ao serviço que já existia (mesmas validações, mesmos registros); as travas que não são «autorização» continuam: chave do servidor (parada de emergência), limites diários,
 * conferência de boleto duplicado na Cora e consentimento por contato no WhatsApp.
 */
export type Fn = "boletos" | "email" | "sistema" | "whatsapp" | "regua";
export const REGUA_KINDS = ["d_menos_3", "d0", "d_mais_3", "d_mais_7"] as const;
export type PanelRow = {
  fn: Fn; on: boolean; canChange: boolean;
  /** a chave de emergência do servidor está desligada (a função NÃO funciona agora, mesmo ligada aqui) */
  serverOff: boolean;
  /** impeditivo: a chave está desligada no servidor, falta a conta etc. (a chave não pode ser ligada agora) */
  blocked: string | null;
  /** extras de cada função */
  detail: Record<string, string | number | boolean | string[] | null>;
  at: Date | null;
};
export type Panel = { rows: Record<Fn, PanelRow>; role: string };

const FN_PERM = { boletos: "issuance.manage", email: "providers.credentials", sistema: "providers.credentials", whatsapp: "whatsapp.authorize", regua: "whatsapp.authorize" } as const;
const audit = (x: DB, companyId: string, actorId: string, fn: Fn, on: boolean, extra: Record<string, unknown> = {}) => x.insert(auditLog).values({ companyId, actorId, action: "authorization.panel", detail: { function: fn, on, ...extra } });
/** Referência da autorização: sem nome de pessoa (quem ligou fica no `authorized_by` e na auditoria). */
const stamp = () => `Painel de autorizações — ligado em ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Manaus" })}`;

export async function getPanel(db: DB, actorId: string, companyId: string, env: Record<string, string | undefined> = process.env): Promise<Panel> {
  await requirePerm(db, actorId, companyId, "billing.read");
  const role = (await activeRole(db, actorId, companyId))!;
  const [iss] = await db.select().from(issuanceSettings).where(eq(issuanceSettings.companyId, companyId));
  const [acc] = await db.select({ id: emailAccounts.id, systemEnabled: emailAccounts.systemEnabled, systemEnabledAt: emailAccounts.systemEnabledAt }).from(emailAccounts).where(eq(emailAccounts.companyId, companyId));
  const mail = await activeAuthorization(db, companyId);
  const [wa] = await db.select().from(whatsappCompanySettings).where(eq(whatsappCompanySettings.companyId, companyId));
  const prod = iss?.boletoProvider === "cora_producao";
  const rows: Record<Fn, PanelRow> = {
    boletos: {
      fn: "boletos", serverOff: !prodEmissionOn(env), on: prod && iss?.paused === false, canChange: can(role, FN_PERM.boletos), at: prod ? iss?.liveAuthorizedAt ?? null : null,
      blocked: prodEmissionOn(env) ? null : "A emissão em produção está desligada neste servidor (chave de emergência).",
      detail: { provider: iss?.boletoProvider ?? "simulado", paused: iss?.paused ?? true, canary: iss?.liveCanary ?? true, dailyLimit: iss?.dailyLimit ?? 20, ...(await openBoletoRequests(db, companyId).then((o) => ({ pendingRequests: o.pending, inFlightRequests: o.inFlight }))) },
    },
    email: {
      fn: "email", serverOff: !flagOn(env), on: !!mail, canChange: can(role, FN_PERM.email), at: mail?.createdAt ?? null,
      blocked: !flagOn(env) ? "O envio de e-mail está desligado neste servidor (chave de emergência)." : !acc ? "Cadastre antes a conta de e-mail em Integrações → E-mail." : null,
      detail: { scope: mail ? (mail.allowed.includes(ALLOW_ALL) ? "todos" : "lista") : null, dailyLimit: mail?.dailyLimit ?? 50, sentToday: mail ? await sentToday(db, companyId) : 0 },
    },
    sistema: {
      fn: "sistema", serverOff: !flagOn(env), on: !!acc?.systemEnabled, canChange: can(role, FN_PERM.sistema), at: acc?.systemEnabled ? acc.systemEnabledAt ?? null : null,
      blocked: !flagOn(env) ? "O envio de e-mail está desligado neste servidor (chave de emergência)." : !acc ? "Cadastre antes a conta de e-mail em Integrações → E-mail." : null,
      detail: {},
    },
    whatsapp: {
      fn: "whatsapp", serverOff: !sendOn(env), on: !!wa?.sendEnabled, canChange: can(role, FN_PERM.whatsapp), at: wa?.authorizedAt ?? null,
      blocked: sendOn(env) ? null : "O envio por WhatsApp está desligado neste servidor (chave de emergência).",
      detail: { dailyCap: wa?.dailyCap ?? CAPS.companyDaily },
    },
    regua: {
      fn: "regua", serverOff: !automationOn(env), on: !!wa?.automationEnabled, canChange: can(role, FN_PERM.regua), at: wa?.automationAuthorizedAt ?? null,
      blocked: !automationOn(env) ? "A régua automática está desligada neste servidor (chave de emergência)." : !wa?.sendEnabled ? "Ligue antes o WhatsApp: a régua depende dele." : null,
      detail: { kinds: (wa?.automationKinds ?? []) as string[] },
    },
  };
  return { rows, role };
}

const asLimit = (v: unknown, min: number, max: number, what: string) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Invalid(`${what}: número de ${min} a ${max}`); return n; };

/** BOLETOS REAIS. Ligar = Cora de PRODUÇÃO armada (em modo cuidadoso: poucos por dia) e emissão liberada; desligar = PAUSAR a emissão (nada é emitido; o que já existe não muda). */
export async function setBoletos(db: DB, actorId: string, companyId: string, on: boolean, o: { canary?: boolean } = {}, env: Record<string, string | undefined> = process.env) {
  await requirePerm(db, actorId, companyId, FN_PERM.boletos);
  const [cur] = await db.select().from(issuanceSettings).where(eq(issuanceSettings.companyId, companyId));
  const dailyLimit = cur?.dailyLimit ?? 20, prod = cur?.boletoProvider === "cora_producao";
  if (on && !prodEmissionOn(env)) throw new Invalid("A emissão em produção está desligada neste servidor (chave de emergência). Nada foi ligado");
  try {
    if (!on) {
      if (cur) await saveIssuanceSettings(db, actorId, companyId, { paused: true, dailyLimit });
    } else if (!prod) {
      await saveIssuanceSettings(db, actorId, companyId, { paused: false, dailyLimit, boletoProvider: "cora_producao", liveConfirm: LIVE_CONFIRM_PHRASE }); // entra SEMPRE em modo cuidadoso
    } else {
      await saveIssuanceSettings(db, actorId, companyId, { paused: false, dailyLimit, ...(o.canary === undefined ? {} : { liveCanary: o.canary, liveConfirm: LIVE_CONFIRM_PHRASE }) });
    }
  } catch (e) { if (e instanceof LiveNotAvailable) throw new Invalid(e.message); throw e; }
  await audit(db, companyId, actorId, "boletos", on, o.canary === undefined ? {} : { canary: o.canary });
}
/** Cancela as solicitações de boleto ainda NÃO enviadas (as pedidas antes de ligar os boletos reais), para poder trocar o provedor. Não emite nada; depois é só solicitar de novo no lote. */
export async function cancelPendingRequests(db: DB, actorId: string, companyId: string) {
  return cancelPendingBoletos(db, actorId, companyId); // exige issuance.request; a própria função audita (issuance.pending_cancelled)
}
/** Modo cuidadoso dos boletos reais (3 por dia). Sair dele libera o limite diário configurado. */
export async function setBoletosCanary(db: DB, actorId: string, companyId: string, canary: boolean, env: Record<string, string | undefined> = process.env) {
  await requirePerm(db, actorId, companyId, FN_PERM.boletos);
  const [cur] = await db.select().from(issuanceSettings).where(eq(issuanceSettings.companyId, companyId));
  if (cur?.boletoProvider !== "cora_producao" || cur.paused) throw new Invalid("O modo cuidadoso vale quando os boletos reais estão ligados");
  await setBoletos(db, actorId, companyId, true, { canary }, env);
}

/** E-MAIL A CLIENTES. Ligar = autorização ativa para os contatos financeiros dos clientes cadastrados, com limite diário; desligar = revoga. */
export async function setEmail(db: DB, actorId: string, companyId: string, on: boolean, o: { dailyLimit?: unknown } = {}, env: Record<string, string | undefined> = process.env) {
  await requirePerm(db, actorId, companyId, FN_PERM.email);
  if (!on) {
    try { await revokeEmailLive(db, actorId, companyId); } catch (e) { if (!(e instanceof Invalid && /Não há autorização/.test(e.message))) throw e; }
    await audit(db, companyId, actorId, "email", false);
    return;
  }
  if (!flagOn(env)) throw new Invalid("O envio de e-mail está desligado neste servidor (chave de emergência). Nada foi ligado");
  const cur = await activeAuthorization(db, companyId);
  if (cur) return setEmailLimit(db, actorId, companyId, o.dailyLimit ?? cur.dailyLimit, env); // já ligada: nunca amplia os destinatários
  const dailyLimit = o.dailyLimit === undefined || o.dailyLimit === "" ? 50 : asLimit(o.dailyLimit, 1, 200, "Limite diário de e-mails");
  await authorizeEmailLive(db, actorId, companyId, { reference: stamp(), allowed: ALLOW_ALL, dailyLimit });
  await audit(db, companyId, actorId, "email", true, { dailyLimit });
}
/** E-MAIL DO SISTEMA (redefinição de senha e convites). Chave própria, SEM relação com a autorização de e-mail a clientes: nunca envia cobrança e só escreve a UM destinatário por vez (quem pediu a senha ou o convidado). */
export async function setSistema(db: DB, actorId: string, companyId: string, on: boolean, env: Record<string, string | undefined> = process.env) {
  await requirePerm(db, actorId, companyId, FN_PERM.sistema);
  if (on && !flagOn(env)) throw new Invalid("O envio de e-mail está desligado neste servidor (chave de emergência). Nada foi ligado");
  const [acc] = await db.select({ id: emailAccounts.id, on: emailAccounts.systemEnabled }).from(emailAccounts).where(eq(emailAccounts.companyId, companyId));
  if (!acc) { if (on) throw new Invalid("Cadastre antes a conta de e-mail em Integrações → E-mail"); return; }
  if (acc.on === on) return;
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.update(emailAccounts).set(on ? { systemEnabled: true, systemEnabledAt: new Date(), systemEnabledBy: actorId, updatedAt: new Date() } : { systemEnabled: false, systemEnabledAt: null, systemEnabledBy: null, updatedAt: new Date() }).where(eq(emailAccounts.id, acc.id));
    await audit(x, companyId, actorId, "sistema", on);
  });
}
/** Só muda o limite diário, MANTENDO destinatários e referência. Exige a função já ligada (nunca liga nem amplia). */
export async function setEmailLimit(db: DB, actorId: string, companyId: string, dailyLimit: unknown, env: Record<string, string | undefined> = process.env) {
  await requirePerm(db, actorId, companyId, FN_PERM.email);
  const cur = await activeAuthorization(db, companyId);
  if (!cur) throw new Invalid("Ligue antes o e-mail para clientes");
  if (!flagOn(env)) throw new Invalid("O envio de e-mail está desligado neste servidor (chave de emergência). Nada foi alterado");
  const n = asLimit(dailyLimit, 1, 200, "Limite diário de e-mails");
  await authorizeEmailLive(db, actorId, companyId, { reference: cur.reference, allowed: cur.allowed.join(","), dailyLimit: n });
  await audit(db, companyId, actorId, "email", true, { dailyLimit: n, limitOnly: true });
}

/** WHATSAPP (cobrança a clientes). O consentimento de cada contato continua sendo exigido no envio. */
export async function setWhatsapp(db: DB, actorId: string, companyId: string, on: boolean, o: { dailyCap?: unknown } = {}, env: Record<string, string | undefined> = process.env) {
  await requirePerm(db, actorId, companyId, FN_PERM.whatsapp);
  if (on && !sendOn(env)) throw new Invalid("O envio por WhatsApp está desligado neste servidor (chave de emergência). Nada foi ligado");
  const [cur] = await db.select().from(whatsappCompanySettings).where(eq(whatsappCompanySettings.companyId, companyId));
  if (on && cur?.sendEnabled) return setWhatsappLimit(db, actorId, companyId, o.dailyCap ?? cur.dailyCap, env); // já ligado: só ajusta o limite
  const dailyCap = on ? (o.dailyCap === undefined || o.dailyCap === "" ? cur?.dailyCap ?? CAPS.companyDaily : asLimit(o.dailyCap, 1, CAPS.companyDaily, "Limite diário de WhatsApp")) : undefined;
  await saveCompanySettings(db, actorId, companyId, on ? { enable: true, reference: stamp(), dailyCap, phrase: SEND_PHRASE } : { enable: false });
  await audit(db, companyId, actorId, "whatsapp", on, on ? { dailyCap } : {});
}

/** Só muda o limite diário do WhatsApp, mantendo a referência. Exige o WhatsApp já ligado. */
export async function setWhatsappLimit(db: DB, actorId: string, companyId: string, dailyCap: unknown, env: Record<string, string | undefined> = process.env) {
  await requirePerm(db, actorId, companyId, FN_PERM.whatsapp);
  const [cur] = await db.select().from(whatsappCompanySettings).where(and(eq(whatsappCompanySettings.companyId, companyId), eq(whatsappCompanySettings.sendEnabled, true)));
  if (!cur) throw new Invalid("Ligue antes o WhatsApp para clientes");
  if (!sendOn(env)) throw new Invalid("O envio por WhatsApp está desligado neste servidor (chave de emergência). Nada foi alterado");
  const n = asLimit(dailyCap, 1, CAPS.companyDaily, "Limite diário de WhatsApp");
  await saveCompanySettings(db, actorId, companyId, { enable: true, reference: cur.reference ?? stamp(), dailyCap: n, phrase: SEND_PHRASE });
  await audit(db, companyId, actorId, "whatsapp", true, { dailyCap: n, limitOnly: true });
}

/** RÉGUA de WhatsApp. Ligar com as réguas escolhidas (D-3, D0, D+3, D+7); desligar suprime o que estava na fila automática. */
export async function setRegua(db: DB, actorId: string, companyId: string, on: boolean, o: { kinds?: unknown } = {}, env: Record<string, string | undefined> = process.env) {
  await requirePerm(db, actorId, companyId, FN_PERM.regua);
  if (on && !automationOn(env)) throw new Invalid("A régua automática está desligada neste servidor (chave de emergência). Nada foi ligado");
  const [cur] = await db.select().from(whatsappCompanySettings).where(eq(whatsappCompanySettings.companyId, companyId));
  if (on && cur?.automationEnabled && !(Array.isArray(o.kinds) ? o.kinds.length : o.kinds)) return; // já ligada e nada novo a salvar
  const given = Array.isArray(o.kinds) ? o.kinds : o.kinds ? [o.kinds] : [];
  const kinds = given.length ? given : (cur?.automationKinds?.length ? cur.automationKinds : ["d0"]);
  await saveAutomation(db, actorId, companyId, on ? { enable: true, kinds, reference: stamp(), phrase: AUTO_PHRASE } : { enable: false });
  await audit(db, companyId, actorId, "regua", on, on ? { kinds } : {});
}

/** Só troca as réguas escolhidas. Exige a régua já ligada (nunca liga). */
export async function setReguaKinds(db: DB, actorId: string, companyId: string, kinds: unknown, env: Record<string, string | undefined> = process.env) {
  await requirePerm(db, actorId, companyId, FN_PERM.regua);
  const [cur] = await db.select().from(whatsappCompanySettings).where(and(eq(whatsappCompanySettings.companyId, companyId), eq(whatsappCompanySettings.automationEnabled, true)));
  if (!cur) throw new Invalid("Ligue antes a régua automática");
  if (!automationOn(env)) throw new Invalid("A régua automática está desligada neste servidor (chave de emergência). Nada foi alterado");
  const given = Array.isArray(kinds) ? kinds : kinds ? [kinds] : [];
  if (given.length === 0) throw new Invalid("Escolha ao menos uma régua");
  await saveAutomation(db, actorId, companyId, { enable: true, kinds: given, reference: cur.automationReference ?? stamp(), phrase: AUTO_PHRASE });
  await audit(db, companyId, actorId, "regua", true, { kinds: given, kindsOnly: true });
}
