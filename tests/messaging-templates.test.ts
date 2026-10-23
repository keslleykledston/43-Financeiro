import { describe, expect, it } from "vitest";
import { DEFAULTS, KINDS, SAMPLE_VARS, ladder, render, toEmailHtml, validateTemplate, escapeHtml } from "@/modules/messaging/templates";
import { addDays } from "@/modules/messaging/dates";

describe("E06 modelos de mensagem (regras puras)", () => {
  it("modelos padrão são válidos nos dois canais", () => {
    for (const k of KINDS) {
      expect(validateTemplate("email", DEFAULTS[k].subject, DEFAULTS[k].body)).toEqual({ ok: true });
      expect(validateTemplate("whatsapp", "", DEFAULTS[k].body)).toEqual({ ok: true });
    }
  });
  it("campo desconhecido, chaves soltas e HTML são rejeitados", () => {
    expect(validateTemplate("whatsapp", "", "Oi {{senha}}")).toMatchObject({ ok: false, error: expect.stringContaining("{{senha}}") });
    expect(validateTemplate("whatsapp", "", "Oi {{cliente")).toMatchObject({ ok: false });
    expect(validateTemplate("whatsapp", "", "Oi {{ {{cliente}} }}")).toMatchObject({ ok: false });
    expect(validateTemplate("whatsapp", "", "<script>alert(1)</script>")).toMatchObject({ ok: false, error: expect.stringContaining("HTML") });
    expect(validateTemplate("whatsapp", "", "<img src=x onerror=1>")).toMatchObject({ ok: false });
  });
  it("assunto: obrigatório no e-mail, uma linha (sem injeção de cabeçalho), proibido no WhatsApp", () => {
    expect(validateTemplate("email", "", "x")).toMatchObject({ ok: false });
    expect(validateTemplate("email", "Oi\r\nBcc: alguem@x.com", "x")).toMatchObject({ ok: false, error: expect.stringContaining("uma linha") });
    expect(validateTemplate("whatsapp", "assunto", "x")).toMatchObject({ ok: false });
    expect(validateTemplate("email", "a".repeat(201), "x")).toMatchObject({ ok: false });
    expect(validateTemplate("whatsapp", "", "a".repeat(4001))).toMatchObject({ ok: false });
    expect(validateTemplate("whatsapp", "", "   ")).toMatchObject({ ok: false });
    expect(validateTemplate("whatsapp", "", "ok\u0000")).toMatchObject({ ok: false });
  });
  it("renderização: substitui só os campos permitidos e não reinterpreta valores", () => {
    const v = { ...SAMPLE_VARS, cliente: "Fulano {{valor}} \r\nBcc: x" };
    const out = render("Olá {{ cliente }} — {{valor}} {{inexistente}}", v);
    expect(out).toBe("Olá Fulano {{valor}} Bcc: x — R$ 2.500,00 ");
  });
  it("saída HTML escapa valores perigosos", () => {
    const html = toEmailHtml(render("Olá {{cliente}}\nlinha 2", { ...SAMPLE_VARS, cliente: '<img src=x onerror="a">&' }));
    expect(html).toBe("Olá &lt;img src=x onerror=&quot;a&quot;&gt;&amp;<br>linha 2");
    expect(html).not.toMatch(/<img/);
    expect(escapeHtml("'")).toBe("&#39;");
  });
  it("régua: emissão + D-3, D0, D+3, D+7 e revisão D+15 a partir do vencimento", () => {
    expect(ladder({ issueDate: "2026-10-01", dueDate: "2026-11-14" })).toEqual([
      { kind: "emissao", date: "2026-10-01" }, { kind: "d_menos_3", date: "2026-11-11" }, { kind: "d0", date: "2026-11-14" },
      { kind: "d_mais_3", date: "2026-11-17" }, { kind: "d_mais_7", date: "2026-11-21" }, { kind: "revisao_d15", date: "2026-11-29" },
    ]);
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });
});
