import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/lib/db";
import { auditLog, contracts, customers, notes, users } from "@/lib/db/schema";
import { Invalid, requirePerm } from "@/modules/identity/service";

/**
 * Comentários (E21): notas SÓ DE ACRÉSCIMO em contrato ou cliente. O banco recusa editar e apagar (trigger), então o histórico é confiável.
 * Quem escreve: quem altera contratos (contracts.write) ou cadastros (crm.write); quem lê: quem lê o cadastro. O texto NUNCA vai para o registro de atividades.
 */
export type Target = { contractId: string } | { customerId: string };
export const NOTE_MAX = 2000;
const uuid = z.string().uuid();

const perm = (t: Target, write: boolean) => ("contractId" in t ? (write ? "contracts.write" : "contracts.read") : write ? "crm.write" : "crm.read") as "contracts.write" | "contracts.read" | "crm.write" | "crm.read";

async function assertTarget(x: DB, companyId: string, t: Target) {
  if ("contractId" in t) {
    if (!uuid.safeParse(t.contractId).success) throw new Invalid("Contrato inválido");
    const [r] = await x.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, t.contractId), eq(contracts.companyId, companyId)));
    if (!r) throw new Invalid("Contrato não encontrado");
  } else {
    if (!uuid.safeParse(t.customerId).success) throw new Invalid("Cliente inválido");
    const [r] = await x.select({ id: customers.id }).from(customers).where(and(eq(customers.id, t.customerId), eq(customers.companyId, companyId)));
    if (!r) throw new Invalid("Cliente não encontrado");
  }
}

export async function addNote(db: DB, actorId: string, companyId: string, target: Target, body: unknown) {
  await requirePerm(db, actorId, companyId, perm(target, true));
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) throw new Invalid("Escreva o comentário");
  if (text.length > NOTE_MAX) throw new Invalid(`Comentário muito longo (máximo ${NOTE_MAX} caracteres)`);
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await assertTarget(x, companyId, target);
    const [n] = await x.insert(notes).values({ companyId, authorId: actorId, body: text, contractId: "contractId" in target ? target.contractId : null, customerId: "customerId" in target ? target.customerId : null }).returning({ id: notes.id });
    await x.insert(auditLog).values({ companyId, actorId, action: "note.added", detail: { noteId: n.id, ...("contractId" in target ? { contractId: target.contractId } : { customerId: target.customerId }) } });
    return n;
  });
}

export async function listNotes(db: DB, actorId: string, companyId: string, target: Target) {
  await requirePerm(db, actorId, companyId, perm(target, false));
  if ("contractId" in target ? !uuid.safeParse(target.contractId).success : !uuid.safeParse(target.customerId).success) return [];
  const where = and(eq(notes.companyId, companyId), "contractId" in target ? eq(notes.contractId, target.contractId) : eq(notes.customerId, target.customerId));
  return db.select({ id: notes.id, body: notes.body, at: notes.createdAt, author: users.name }).from(notes).innerJoin(users, eq(users.id, notes.authorId)).where(where).orderBy(desc(notes.createdAt), desc(notes.id)).limit(200);
}
