import { describe, expect, it } from "vitest";
import { MAX_BYTES, ParseError, decodeText, parseCsvStatement, parseDate, parseOfx, parseSignedMoney, parseStatement, withRefKeys } from "@/modules/banking/parsers";

const enc = (s: string) => new TextEncoder().encode(s);

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
CHARSET:1252

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>403<ACCTID>12345-6789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001<DTEND>20261031
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261005120000[-3:BRT]<TRNAMT>2500.00<FITID>A1<NAME>PIX RECEBIDO<MEMO>CLIENTE UM 11222333000181
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261006<TRNAMT>-39.90<FITID>A2<MEMO>TARIFA MENSAL
</BANKTRANLIST>
<LEDGERBAL><BALAMT>2460.10<DTASOF>20261031</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const OFX_XML = `<?xml version="1.0"?><OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>9876</ACCTID></BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261005</DTPOSTED><TRNAMT>10,50</TRNAMT><FITID>X1</FITID><MEMO>Teste</MEMO></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("E08 leitores de extrato", () => {
  it("valores monetários com sinal em vários formatos; inválidos viram null", () => {
    const ok: [string, number][] = [["1.234,56", 123456], ["-1.234,56", -123456], ["R$ 1.234,56", 123456], ["(1.234,56)", -123456], ["1234.56", 123456], ["-0,05", -5], ["1234", 123400], ["1.234", 123400], ["12,5", 1250], ["123,45-", -12345], ["+10,00", 1000]];
    for (const [raw, c] of ok) expect(parseSignedMoney(raw), raw).toBe(c);
    for (const raw of ["", "abc", "1,234,56", "12.3.4", "1,234", "R$", "--5", "99999999999999,00"]) expect(parseSignedMoney(raw), raw).toBeNull();
  });
  it("datas: dd/mm/aaaa, aaaa-mm-dd, aaaammdd; inexistentes são recusadas", () => {
    expect(parseDate("05/10/2026")).toBe("2026-10-05"); expect(parseDate("2026-10-05")).toBe("2026-10-05"); expect(parseDate("20261005120000[-3:BRT]")).toBe("2026-10-05");
    expect(parseDate("31/02/2026")).toBeNull(); expect(parseDate("2026-13-01")).toBeNull(); expect(parseDate("lixo")).toBeNull(); expect(parseDate("")).toBeNull();
  });
  it("OFX 1.x (SGML, sem tags de fechamento): transações, saldo, final da conta", () => {
    const s = parseOfx(OFX_SGML);
    expect(s).toMatchObject({ format: "ofx", ledgerBalanceCents: 246010, ledgerDate: "2026-10-31", accountLast4: "6789" });
    expect(s.rows).toEqual([
      { lineNo: 1, postedAt: "2026-10-05", amountCents: 250000, description: "PIX RECEBIDO - CLIENTE UM 11222333000181", externalRef: "A1" },
      { lineNo: 2, postedAt: "2026-10-06", amountCents: -3990, description: "TARIFA MENSAL", externalRef: "A2" },
    ]);
  });
  it("OFX 2.x (XML) e vírgula decimal", () => {
    const s = parseOfx(OFX_XML);
    expect(s.rows).toEqual([{ lineNo: 1, postedAt: "2026-10-05", amountCents: 1050, description: "Teste", externalRef: "X1" }]);
    expect(s.accountLast4).toBe("9876"); expect(s.ledgerBalanceCents).toBeNull();
  });
  it("OFX inválido: sem transações, data/valor ruins, valor zero, FITID repetido", () => {
    expect(() => parseOfx("<OFX></OFX>")).toThrow(/Nenhuma transação/);
    expect(() => parseOfx("<STMTTRN><DTPOSTED>20261340<TRNAMT>1.00<FITID>1")).toThrow(/data inválida/);
    expect(() => parseOfx("<STMTTRN><DTPOSTED>20261001<TRNAMT>abc<FITID>1")).toThrow(/valor inválido/);
    expect(() => parseOfx("<STMTTRN><DTPOSTED>20261001<TRNAMT>0.00<FITID>1")).toThrow(/valor inválido/);
    expect(() => parseOfx("<STMTTRN><DTPOSTED>20261001<TRNAMT>1.00<FITID>1<STMTTRN><DTPOSTED>20261002<TRNAMT>2.00<FITID>1")).toThrow(/repete/);
  });
  it("CSV genérico: ; ou ,, acentos no cabeçalho, Valor com sinal, ou Crédito/Débito, Id opcional", () => {
    const a = parseCsvStatement("Data;Descrição;Valor;Id\r\n01/10/2026;PIX CLIENTE;2.500,00;K1\r\n02/10/2026;TARIFA;-39,90;K2\r\n");
    expect(a.rows.map((r) => [r.postedAt, r.amountCents, r.description, r.externalRef])).toEqual([["2026-10-01", 250000, "PIX CLIENTE", "K1"], ["2026-10-02", -3990, "TARIFA", "K2"]]);
    expect(() => parseCsvStatement("date,description,amount\n2026-10-01,Pix,\"1,234.50\"\n")).toThrow(/valor inválido/); // ambíguo para o leitor pt-BR: recusa em vez de adivinhar
    const b = parseCsvStatement("date,description,amount\n2026-10-01,Pix,1234.50\n");
    expect(b.rows[0].amountCents).toBe(123450);
  });
  it("CSV com Crédito/Débito e cabeçalho inválido", () => {
    const c = parseCsvStatement("Data;Histórico;Crédito;Débito\n01/10/2026;Depósito;100,00;\n02/10/2026;Saque;;30,00\n");
    expect(c.rows.map((r) => r.amountCents)).toEqual([10000, -3000]);
    expect(() => parseCsvStatement("a;b;c\n1;2;3")).toThrow(/Cabeçalho não reconhecido/);
    expect(() => parseCsvStatement("Data;Descrição;Valor")).toThrow(/ao menos uma linha/);
    expect(() => parseCsvStatement("Data;Descrição;Valor\n31/02/2026;x;1,00")).toThrow(/data inválida/);
    expect(() => parseCsvStatement("Data;Descrição;Valor\n01/10/2026;x;0,00")).toThrow(/valor inválido/);
    expect(() => parseCsvStatement("Data;Descrição;Valor;Id\n01/10/2026;x;1,00;A\n02/10/2026;y;2,00;A")).toThrow(/repete/);
  });
  it("detecção de formato, binário, vazio, tamanho e codificação", () => {
    expect(parseStatement(enc(OFX_XML)).format).toBe("ofx");
    expect(parseStatement(enc("Data;Descrição;Valor\n01/10/2026;x;1,00\n")).format).toBe("csv");
    expect(() => decodeText(new Uint8Array([1, 2, 0, 3]))).toThrow(ParseError);
    expect(() => decodeText(new Uint8Array(0))).toThrow(/vazio/);
    expect(() => decodeText(new Uint8Array(MAX_BYTES + 1).fill(65))).toThrow(/2 MB/);
    const latin1 = Uint8Array.from([..."Data;Descri"].map((c) => c.charCodeAt(0)).concat([0xe7, 0xe3, 0x6f]).concat([..." ;Valor\n01/10/2026;Jos"].map((c) => c.charCodeAt(0))).concat([0xe9]).concat([..." ;1,00\n"].map((c) => c.charCodeAt(0))));
    expect(parseStatement(latin1).rows[0].description).toBe("José");
  });
  it("descrição: controle removido, espaços colapsados, limitada a 200", () => {
    const r = parseCsvStatement(`Data;Descrição;Valor\n01/10/2026;"a\tb\n  c ${"x".repeat(300)}";1,00\n`).rows[0];
    expect(r.description.startsWith("a b c x")).toBe(true); expect(r.description.length).toBe(200);
  });
  it("chaves de deduplicação: ref do banco; sem ref, hash + ocorrência (dois Pix iguais no arquivo são dois)", () => {
    const base = { lineNo: 1, postedAt: "2026-10-01", amountCents: 1000, description: "Pix  Fulano", externalRef: null };
    const keys = withRefKeys([base, { ...base, lineNo: 2, description: "PIX FULANO" }, { ...base, lineNo: 3, amountCents: 1001 }, { ...base, lineNo: 4, externalRef: "ABC" }]).map((r) => r.refKey);
    expect(keys[0]).toMatch(/^fp:[0-9a-f]{32}:1$/); expect(keys[1]).toBe(keys[0].replace(/:1$/, ":2")); expect(keys[2]).toMatch(/:1$/); expect(keys[2]).not.toBe(keys[0]); expect(keys[3]).toBe("ref:ABC");
    expect(withRefKeys([base])[0].refKey).toBe(keys[0]); // estável entre importações
  });
});
