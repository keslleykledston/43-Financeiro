/**
 * Converte a planilha de boletos (.xlsx) em CSVs de importação de contratos. NÃO toca no banco nem na rede.
 * Uso (no container de ferramentas): pnpm tsx scripts/planilha-para-csv.ts <entrada.xlsx> <pasta-de-saida> [ano]
 * Saída (arquivos privados, 0600; contêm dados de clientes: nunca versionar):
 *   contratos-solutions.csv, contratos-call.csv  → importar em "Contratos → Importar" da empresa correspondente
 *   resumo.txt                                   → só contagens
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import readXlsxFile from "read-excel-file/node";
import { consolidate, readWorkbook, toContractCsv, type Cell, type Sheet } from "../src/modules/contracts/planilha";

const [input, outDir, yearArg] = process.argv.slice(2);
if (!input || !outDir) { console.error("uso: planilha-para-csv.ts <entrada.xlsx> <pasta-de-saida> [ano]"); process.exit(2); }
const year = Number(yearArg ?? new Date().getFullYear());

const sheets: Sheet[] = (await readXlsxFile(resolve(input))).map((s) => ({ name: s.sheet, rows: s.data as unknown as Cell[][] }));
const entries = readWorkbook(sheets, year);
const all = consolidate(entries);
mkdirSync(outDir, { recursive: true });
const write = (file: string, body: string) => { const p = join(outDir, file); writeFileSync(p, body, { mode: 0o600 }); chmodSync(p, 0o600); };
const by = (b: "solutions" | "call") => all.filter((c) => c.block === b);
write("contratos-solutions.csv", toContractCsv(by("solutions")));
write("contratos-call.csv", toContractCsv(by("call")));
const lines = [
  `abas lidas: ${sheets.map((s) => s.name).join(", ")}`,
  `linhas de cobrança lidas: ${entries.length}`,
  ...(["solutions", "call"] as const).map((b) => `${b}: ${by(b).length} contratos · sem documento: ${by(b).filter((c) => !c.documentRaw).length} · documento inválido: ${by(b).filter((c) => c.documentRaw && !c.document).length} · com parceiro de comissão: ${by(b).filter((c) => c.commissionPartner).length} · encerrados (sumiram das últimas abas): ${by(b).filter((c) => c.endAt).length}`),
];
write("resumo.txt", lines.join("\n") + "\n");
console.log(lines.join("\n"));
