import { parseDocument } from "@/lib/validators/document";
import type { Entry } from "@/modules/contracts/planilha";

/**
 * Preenche os contatos FINANCEIROS dos clientes a partir da planilha de boletos (colunas «E-MAIL» e «CONTATO FIN.»). Funções PURAS: sem banco e sem arquivo.
 * Regras: vale a linha mais recente que tem o dado; TODOS os e-mails válidos viram contato financeiro (a equipe hoje manda para todos); o telefone vai para o contato principal
 * (com o nome da pessoa, quando a célula traz); nada é duplicado; nunca mexe em contato que não seja da origem «csv» (o do CRM é do CRM).
 */
export type Phone = { digits: string; display: string; mobile: boolean };
export type CellContact = { phone: Phone | null; person: string | null; issue: "sem_telefone" | "tamanho_invalido" | "ddd_invalido" | null };

const LETTERS = /[A-Za-zÀ-ÿ]/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** «(92)99999-9999 - Fulano» → telefone (celular de 11 dígitos ou fixo de 10) + nome. Sem DDD, número malformado ou DDD impossível = `issue` (nunca adivinha). */
export function parseContactCell(raw: string): CellContact {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  const digits = text.replace(/\D/g, "");
  const person = text.replace(/[\d()+.\-_/]/g, " ").replace(/\s+/g, " ").trim();
  const name = person && LETTERS.test(person) ? person.slice(0, 120) : null;
  if (!digits) return { phone: null, person: name, issue: "sem_telefone" };
  const national = digits.startsWith("55") && (digits.length === 12 || digits.length === 13) ? digits.slice(2) : digits;
  if (national.length !== 10 && national.length !== 11) return { phone: null, person: name, issue: "tamanho_invalido" };
  const ddd = Number(national.slice(0, 2));
  if (ddd < 11 || ddd > 99 || national[0] === "0") return { phone: null, person: name, issue: "ddd_invalido" };
  const mobile = national.length === 11 && national[2] === "9";
  if (national.length === 11 && !mobile) return { phone: null, person: name, issue: "tamanho_invalido" };
  const local = national.slice(2);
  const display = `(${national.slice(0, 2)}) ${local.length === 9 ? `${local.slice(0, 5)}-${local.slice(5)}` : `${local.slice(0, 4)}-${local.slice(4)}`}`;
  return { phone: { digits: `55${national}`, display, mobile }, person: name, issue: null };
}

/** Todos os e-mails válidos da célula (separados por ; , ou espaço), em minúsculas, sem repetir. */
export function emailsOf(raw: string): string[] {
  const out: string[] = [];
  for (const p of String(raw ?? "").split(/[;,\s]+/)) { const e = p.trim().toLowerCase(); if (EMAIL.test(e) && e.length <= 254 && !out.includes(e)) out.push(e); }
  return out;
}

export type Wanted = { block: "solutions" | "call"; name: string; document: string | null; emails: string[]; phone: Phone | null; person: string | null; issue: CellContact["issue"]; months: number };

/** Uma linha por cliente (documento; sem documento válido, o nome). O dado mais recente que não está vazio vence, campo a campo. */
export function wantedFromEntries(entries: Entry[]): Wanted[] {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const doc = parseDocument(e.documentRaw)?.digits ?? null;
    const key = `${e.block}|${doc ?? "NOME:" + e.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim()}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }
  const out: Wanted[] = [];
  for (const [key, list] of groups) {
    const recent = [...list].sort((a, b) => b.month.localeCompare(a.month));
    const emails = emailsOf(recent.map((e) => e.email).find((v) => emailsOf(v).length > 0) ?? "");
    const cellRaw = recent.map((e) => e.contact).find((v) => v.trim() !== "") ?? "";
    const cell = parseContactCell(cellRaw);
    const okCell = recent.map((e) => parseContactCell(e.contact)).find((c) => c.phone) ?? cell; // se o mais recente é malformado, usa um mês anterior válido
    const doc = key.split("|")[1].startsWith("NOME:") ? null : key.split("|")[1];
    out.push({ block: recent[0].block, name: recent[0].name, document: doc, emails, phone: okCell.phone, person: okCell.person ?? cell.person, issue: okCell.phone ? null : cell.issue, months: list.length });
  }
  return out;
}

export type ExistingContact = { id: string; name: string; email: string | null; phone: string | null; isFinancial: boolean; source: string };
export type Action =
  | { kind: "insert"; name: string; email: string | null; phone: string | null; why: "email" | "email_adicional" | "telefone" }
  | { kind: "update"; id: string; name?: string; phone?: string; why: "nome_era_telefone" | "preencher_telefone" };

const digitsOf = (s: string | null) => (s ?? "").replace(/\D/g, "");
const sameDigits = (a: string | null, b: string) => { const d = digitsOf(a); return !!d && (d === b || `55${d}` === b || d === b.slice(2)); };

/** O que fazer neste cliente, dado o que ele já tem. Idempotente: rodar de novo com o resultado aplicado não gera ação. */
export function planContacts(existing: ExistingContact[], w: Pick<Wanted, "emails" | "phone" | "person">): Action[] {
  const actions: Action[] = [];
  const cur = existing.map((c) => ({ ...c })); // cópia que reflete as ações já planejadas
  // 1) contato «csv» cujo NOME é um telefone (importação antiga gravou a célula inteira no nome): move para o telefone
  for (const c of cur) {
    if (c.source !== "csv" || c.phone || !/\d{8}/.test(digitsOf(c.name))) continue;
    const p = parseContactCell(c.name);
    if (!p.phone) continue;
    const name = p.person ?? "Financeiro";
    actions.push({ kind: "update", id: c.id, name, phone: p.phone.display, why: "nome_era_telefone" });
    c.name = name; c.phone = p.phone.display;
  }
  // 2) e-mails: cada e-mail válido precisa existir como contato FINANCEIRO
  const toAdd = w.emails.filter((e) => !cur.some((c) => c.isFinancial && (c.email ?? "").toLowerCase() === e));
  // 3) telefone: já existe em algum contato financeiro? senão, vai no principal
  const phoneKnown = !!w.phone && cur.some((c) => c.isFinancial && sameDigits(c.phone, w.phone!.digits));
  let phonePlaced = !w.phone || phoneKnown;
  if (!phonePlaced) {
    const target = cur.find((c) => c.source === "csv" && c.isFinancial && !c.phone && ((c.email ?? "") === "" || w.emails.includes((c.email ?? "").toLowerCase())));
    if (target) { actions.push({ kind: "update", id: target.id, phone: w.phone!.display, ...(w.person && /^(financeiro|contato)/i.test(target.name) ? { name: w.person } : {}), why: "preencher_telefone" }); phonePlaced = true; }
  }
  toAdd.forEach((email, i) => {
    const first = i === 0;
    const attach = first && !phonePlaced && !!w.phone;
    actions.push({ kind: "insert", name: first ? w.person ?? "Financeiro" : "Financeiro (e-mail adicional)", email, phone: attach ? w.phone!.display : null, why: first ? "email" : "email_adicional" });
    if (attach) phonePlaced = true;
  });
  if (!phonePlaced && w.phone) actions.push({ kind: "insert", name: w.person ?? "Financeiro", email: null, phone: w.phone.display, why: "telefone" });
  return actions;
}
