import { CrmError, type CrmAdapter, type CrmPage } from "./types";

/** Adaptador em memória para testes: paginação, falha injetável e itens crus (podem ser inválidos). */
export class MockCrmAdapter implements CrmAdapter {
  calls = 0;
  constructor(public items: unknown[], private opts: { pageSize?: number; failOnCall?: number; failWith?: string; loopCursor?: boolean } = {}) {}

  async listCustomers({ cursor }: { cursor?: string; updatedSince?: string }): Promise<CrmPage> {
    this.calls++;
    if (this.opts.failOnCall === this.calls) throw new CrmError(this.opts.failWith ?? "CRM indisponível", true);
    const size = this.opts.pageSize ?? 100;
    const start = cursor ? Number(cursor) : 0;
    const next = start + size;
    if (this.opts.loopCursor) return { items: this.items.slice(start, next), nextCursor: "0" };
    return { items: this.items.slice(start, next), nextCursor: next < this.items.length ? String(next) : undefined };
  }
}
