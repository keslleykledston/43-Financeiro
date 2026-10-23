import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "@/lib/csv";

describe("parseCsv", () => {
  it("detecta ; e ,", () => {
    expect(parseCsv("a;b;c\n1;2;3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("aspas, delimitador e quebra de linha dentro do campo, CRLF e BOM", () => {
    expect(parseCsv('﻿a;b\r\n"x;y";"linha1\nlinha2"\r\n"diz ""oi""";z')).toEqual([["a", "b"], ["x;y", "linha1\nlinha2"], ['diz "oi"', "z"]]);
  });
  it("ignora linhas vazias", () => {
    expect(parseCsv("a;b\n\n1;2\n;\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("toCsv", () => {
  it("escapa e neutraliza fórmulas (CSV injection)", () => {
    const out = toCsv([["=HYPERLINK(\"x\")", "+55", "ok;ok", "a\"b"]]);
    expect(out).toContain("'=HYPERLINK");
    expect(out).toContain("'+55");
    expect(out).toContain('"ok;ok"');
    expect(out).toContain('"a""b"');
  });
});
