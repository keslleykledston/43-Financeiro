import { describe, expect, it } from "vitest";
import { emailsOf, parseContactCell, planContacts, wantedFromEntries, type Action, type ExistingContact } from "@/modules/crm/contact-fill";
import type { Entry } from "@/modules/contracts/planilha";

const entry = (o: Partial<Entry>): Entry => ({ block: "solutions", month: "2026-10", name: "CLIENTE EXEMPLO", documentRaw: "11.222.333/0001-81", grossCents: 100, netCents: 100, planoCents: null, excedenteCents: null, dueDay: 10, service: "", obs: "", email: "", contact: "", sheet: "Boletos OUT 2026", row: 4, paidRaw: null, dueOn: null, paidOn: null, ...o });

describe("preenchimento de contatos pela planilha — célula «CONTATO FIN.»", () => {
  it("os desenhos reais da planilha viram telefone + nome", () => {
    expect(parseContactCell("(92)99999-0000 - Maria Souza")).toMatchObject({ phone: { digits: "5592999990000", display: "(92) 99999-0000", mobile: true }, person: "Maria Souza", issue: null });
    expect(parseContactCell("(92) 3234-5678 - Setor Financeiro")).toMatchObject({ phone: { digits: "559232345678", display: "(92) 3234-5678", mobile: false }, person: "Setor Financeiro" });
    expect(parseContactCell("(92)999990000")).toMatchObject({ phone: { digits: "5592999990000" }, person: null });
    expect(parseContactCell("92 99999 0000")).toMatchObject({ phone: { display: "(92) 99999-0000" } });
    expect(parseContactCell("(92) 999990000 -")).toMatchObject({ phone: { digits: "5592999990000" }, person: null });
    expect(parseContactCell("+55 (92) 99999-0000 - José")).toMatchObject({ phone: { digits: "5592999990000" }, person: "José" });
  });
  it("nunca adivinha: sem número, número malformado, sem DDD ou DDD impossível viram pendência", () => {
    expect(parseContactCell("Fulano").issue).toBe("sem_telefone");
    expect(parseContactCell("").issue).toBe("sem_telefone");
    expect(parseContactCell("(92)999999-99999").issue).toBe("tamanho_invalido");
    expect(parseContactCell("99999-0000").issue).toBe("tamanho_invalido");        // sem DDD: não chuta
    expect(parseContactCell("(02) 99999-0000").issue).toBe("ddd_invalido");
    expect(parseContactCell("(92) 89999-0000").issue).toBe("tamanho_invalido");   // 11 dígitos que não é celular
    expect(parseContactCell("(92) 3234-5678 - x").phone?.mobile).toBe(false);
    expect(parseContactCell("(92)99999-0000 - x").person).toBe("x");
  });
  it("e-mails: todos os válidos, minúsculos, sem repetir; lixo ignorado", () => {
    expect(emailsOf("Fulano@Empresa.com.br; financeiro@empresa.com.br,  fulano@empresa.com.br")).toEqual(["fulano@empresa.com.br", "financeiro@empresa.com.br"]);
    expect(emailsOf("sem arroba; a@b")).toEqual([]);
    expect(emailsOf("")).toEqual([]);
  });
});

describe("wantedFromEntries — o dado mais recente que existe vence", () => {
  it("um cliente por documento; campo vazio no mês recente usa o mês anterior; contato malformado recente cai para o último válido", () => {
    const w = wantedFromEntries([
      entry({ month: "2026-08", email: "antigo@x.com", contact: "(92)99999-0000 - Maria" }),
      entry({ month: "2026-10", email: "", contact: "(92)999999-99999" }),
      entry({ month: "2026-09", email: "novo@x.com; outro@x.com", contact: "" }),
      entry({ month: "2026-10", documentRaw: "12.ABC.345/01DE-35", name: "OUTRO", email: "o@o.com", contact: "" }),
    ]);
    expect(w).toHaveLength(2);
    const a = w.find((x) => x.document === "11222333000181")!;
    expect(a.emails).toEqual(["novo@x.com", "outro@x.com"]);          // o e-mail mais recente que não é vazio
    expect(a.phone?.display).toBe("(92) 99999-0000");                  // o recente era inválido: usa o de agosto
    expect(a.person).toBe("Maria");
    expect(a.months).toBe(3);
    expect(w.find((x) => x.name === "OUTRO")!.phone).toBeNull();
  });
  it("sem documento válido agrupa pelo nome (sem acento/caixa) e fica sem documento", () => {
    const w = wantedFromEntries([entry({ documentRaw: "", name: "Galego's Net", email: "g@g.com" }), entry({ documentRaw: "", name: "GALEGO'S  NET", month: "2026-09", email: "h@h.com" })]);
    expect(w).toHaveLength(1); expect(w[0].document).toBeNull(); expect(w[0].emails).toEqual(["g@g.com"]);
  });
  it("blocos Solutions e Call do mesmo documento não se misturam", () => {
    expect(wantedFromEntries([entry({}), entry({ block: "call" })])).toHaveLength(2);
  });
});

describe("planContacts — sem duplicar, sem tocar no que não é nosso", () => {
  const W = (emails: string[], phone = "(92)99999-0000 - Maria") => ({ emails, ...(() => { const c = parseContactCell(phone); return { phone: c.phone, person: c.person }; })() });
  const apply = (existing: ExistingContact[], acts: Action[]): ExistingContact[] => {
    const out = existing.map((c) => ({ ...c }));
    let n = 100;
    for (const a of acts) {
      if (a.kind === "insert") out.push({ id: `n${n++}`, name: a.name, email: a.email, phone: a.phone, isFinancial: true, source: "csv" });
      else { const c = out.find((x) => x.id === a.id)!; if (a.name) c.name = a.name; if (a.phone) c.phone = a.phone; }
    }
    return out;
  };
  const crm = (o: Partial<ExistingContact> = {}): ExistingContact => ({ id: "crm1", name: "Pessoa do CRM", email: "crm@x.com", phone: "92 98888-7777", isFinancial: false, source: "crm", ...o });

  it("cliente sem contato: 1º e-mail leva o telefone e o nome; e-mails adicionais viram contatos financeiros", () => {
    const a = planContacts([], W(["a@x.com", "b@x.com", "c@x.com"]));
    expect(a).toEqual([
      { kind: "insert", name: "Maria", email: "a@x.com", phone: "(92) 99999-0000", why: "email" },
      { kind: "insert", name: "Financeiro (e-mail adicional)", email: "b@x.com", phone: null, why: "email_adicional" },
      { kind: "insert", name: "Financeiro (e-mail adicional)", email: "c@x.com", phone: null, why: "email_adicional" },
    ]);
  });
  it("sem e-mail, só telefone: contato financeiro só com telefone; sem nada: nenhuma ação", () => {
    expect(planContacts([], W([]))).toEqual([{ kind: "insert", name: "Maria", email: null, phone: "(92) 99999-0000", why: "telefone" }]);
    expect(planContacts([], { emails: [], phone: null, person: null })).toEqual([]);
  });
  it("IDEMPOTENTE: aplicar e planejar de novo não gera ação", () => {
    for (const ex of [[], [crm()], [{ ...crm(), source: "csv" as const, isFinancial: true, name: "(92)99999-0000 - Maria", phone: null }]]) {
      const w = W(["a@x.com", "b@x.com"]);
      const done = apply(ex, planContacts(ex, w));
      expect(planContacts(done, w)).toEqual([]);
    }
  });
  it("contato do CRM nunca é alterado: mesmo e-mail/telefone do CRM NÃO financeiro ainda gera um contato financeiro nosso (o CRM não marca financeiro)", () => {
    const ex = [crm({ email: "a@x.com", phone: "(92) 99999-0000" })];
    const acts = planContacts(ex, W(["a@x.com"]));
    expect(acts).toEqual([{ kind: "insert", name: "Maria", email: "a@x.com", phone: "(92) 99999-0000", why: "email" }]);
    expect(acts.some((a) => a.kind === "update")).toBe(false);
  });
  it("importação antiga que gravou a célula inteira no NOME (origem csv): move para telefone/nome e não duplica e-mail nem telefone", () => {
    const old: ExistingContact = { id: "c1", name: "(92)99999-0000 - Maria Souza", email: "a@x.com", phone: null, isFinancial: true, source: "csv" };
    const acts = planContacts([old], W(["a@x.com"], "(92)99999-0000 - Maria Souza"));
    expect(acts).toEqual([{ kind: "update", id: "c1", name: "Maria Souza", phone: "(92) 99999-0000", why: "nome_era_telefone" }]);
    const old2: ExistingContact = { ...old, name: "(92)99999-0000" }; // só número no nome → nome padrão
    expect(planContacts([old2], W(["a@x.com"]))).toEqual([{ kind: "update", id: "c1", name: "Financeiro", phone: "(92) 99999-0000", why: "nome_era_telefone" }]);
  });
  it("contato csv financeiro com e-mail mas sem telefone recebe o telefone (e o nome da pessoa se o nome era genérico)", () => {
    const ex: ExistingContact[] = [{ id: "c2", name: "Financeiro", email: "a@x.com", phone: null, isFinancial: true, source: "csv" }];
    expect(planContacts(ex, W(["a@x.com"]))).toEqual([{ kind: "update", id: "c2", phone: "(92) 99999-0000", name: "Maria", why: "preencher_telefone" }]);
  });
  it("contato manual (digitado por alguém) nunca é reescrito, só se acrescenta", () => {
    const ex: ExistingContact[] = [{ id: "m1", name: "Joana", email: null, phone: null, isFinancial: true, source: "manual" }];
    const acts = planContacts(ex, W(["a@x.com"]));
    expect(acts.every((a) => a.kind === "insert")).toBe(true);
  });
});
