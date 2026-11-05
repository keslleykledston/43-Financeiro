/**
 * N2a — DPS (Declaração de Prestação de Serviços) da NFS-e Padrão Nacional, leiaute v1.01 (ADR-039).
 * Função PURA: monta o XML a partir de dados já conferidos. NÃO assina, NÃO fala com a rede, NÃO emite nota.
 * A assinatura (certificado A1) e o envio são da N2b/N2c. O XML é validado contra o XSD oficial em tests/nfse-dps.test.ts.
 * O que não dá para provar sem o ambiente de produção restrita (ex.: IM, pAliq, cTribMun) está marcado «N2b» e deve ser conferido lá.
 */

export type Regime = "mei" | "simples" | "presumido" | "real";
export type DpsInput = {
  /** 1 = produção, 2 = homologação. A prévia/simulação usa SEMPRE 2 (nunca confundir com nota real). */
  environment: 1 | 2;
  emittedAt: Date;
  appVersion: string;
  series: number;
  number: number;
  /** Data da competência (AAAA-MM-DD). */
  competenceDate: string;
  provider: {
    cnpj: string; municipalRegistration: string | null; regime: Regime | null; issRateBps: number | null; issWithheld: boolean;
    /** Município de emissão e da prestação (IBGE, 7 dígitos). */
    cityIbge: string | null;
    /** Código de tributação nacional, 6 dígitos (LC 116: item+subitem+desdobro). */
    tribNacCode: string | null;
  };
  customer: { document: string; name: string; address: { cityIbge: string | null; cep: string | null; street: string | null; number: string | null; complement: string | null; district: string | null } | null };
  service: { description: string; amountCents: number };
};

export class DpsIncomplete extends Error {
  constructor(public readonly missing: string[]) { super(`DPS incompleta: ${missing.join("; ")}`); this.name = "DpsIncomplete"; }
}

const only = (s: string | null | undefined) => String(s ?? "").replace(/\D+/g, "");
const MAP: Record<string, string> = { "–": "-", "—": "-", "‐": "-", "‑": "-", "“": '"', "”": '"', "„": '"', "‘": "'", "’": "'", "‚": "'", "…": "...", "•": "-", "€": "EUR", "™": "", " ": " ", " ": " ", " ": " " };
/** Só caracteres Latin-1 imprimíveis (o leiaute aceita `!`..`ÿ`); sem espaço nas pontas. `lines` mantém quebras de linha. */
export function xsdText(raw: string | null | undefined, max: number, lines = false): string {
  let s = String(raw ?? "").normalize("NFC");
  s = [...s].map((c) => MAP[c] ?? c).join("");
  s = s.replace(/\r\n?/g, "\n");
  s = [...s].map((c) => { const n = c.codePointAt(0)!; if (c === "\n") return lines ? "\n" : " "; if (n < 32 || (n >= 127 && n <= 159)) return " "; if (n > 255) return "?"; return c; }).join("");
  s = lines ? s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ");
  return s.trim().slice(0, max).trim();
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const el = (name: string, value: string | number) => `<${name}>${esc(String(value))}</${name}>`;
const money = (cents: number) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/** AAAA-MM-DDThh:mm:ss-04:00 (Manaus, sem horário de verão). */
export function dhEmi(d: Date): string {
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Manaus", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d);
  return `${p.replace(" ", "T")}-04:00`;
}
const dayManaus = (d: Date) => dhEmi(d).slice(0, 10);
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function dpsId(cityIbge: string, document: string, series: number, number: number): string {
  const doc = only(document);
  return `DPS${cityIbge}${doc.length === 11 ? "1" : "2"}${doc.padStart(14, "0")}${String(series).padStart(5, "0")}${String(number).padStart(15, "0")}`;
}

/** Lista o que falta/está inválido (em português, para a tela). Vazio = dá para montar a DPS. */
export function dpsProblems(i: DpsInput): string[] {
  const m: string[] = [];
  const p = i.provider, c = i.customer;
  if (!/^[0-9]{14}$/.test(only(p.cnpj)) || only(p.cnpj) !== p.cnpj.replace(/[.\-/\s]/g, "")) m.push("CNPJ da empresa prestadora (só números; CNPJ com letras ainda não é aceito pelo leiaute 1.01)");
  if (!p.regime) m.push("regime tributário da empresa");
  if (!/^[0-9]{7}$/.test(only(p.cityIbge))) m.push("código IBGE do município da empresa");
  if (!/^[0-9]{6}$/.test(only(p.tribNacCode))) m.push("código de tributação nacional do serviço (6 dígitos, ex.: 010701 — o contador informa)");
  if (p.regime && p.regime !== "mei" && p.regime !== "simples" && p.issRateBps === null) m.push("alíquota do ISS da empresa");
  const cd = only(c.document);
  if (cd.length !== 11 && cd.length !== 14) m.push("CPF/CNPJ do cliente (tomador)");
  if (!xsdText(c.name, 300)) m.push("razão social do cliente (tomador)");
  if (!xsdText(i.service.description, 2000, true)) m.push("descrição do serviço");
  if (!Number.isSafeInteger(i.service.amountCents) || i.service.amountCents <= 0) m.push("valor do serviço (maior que zero)");
  if (!validDate(i.competenceDate)) m.push("data de competência");
  else if (i.competenceDate > dayManaus(i.emittedAt)) m.push("competência no futuro (a nota não pode ter competência posterior à emissão)");
  if (!Number.isSafeInteger(i.number) || i.number < 1 || i.number > 999_999_999_999_999) m.push("número da DPS");
  if (!Number.isSafeInteger(i.series) || i.series < 0 || i.series > 99_999) m.push("série da DPS");
  if (!xsdText(i.appVersion, 20)) m.push("versão do aplicativo");
  return m;
}

const CUSTOMER_ADDRESS_FIELDS = ["cityIbge", "cep", "street", "number", "district"] as const;
/** O endereço do tomador só entra se vier completo (o leiaute exige logradouro, número, bairro, município e CEP juntos). */
export function customerAddressComplete(a: DpsInput["customer"]["address"]): boolean {
  if (!a) return false;
  return /^[0-9]{7}$/.test(only(a.cityIbge)) && /^[0-9]{8}$/.test(only(a.cep)) && CUSTOMER_ADDRESS_FIELDS.every((k) => !!xsdText(a[k], 60));
}

export function buildDps(i: DpsInput): { xml: string; id: string; warnings: string[] } {
  const problems = dpsProblems(i);
  if (problems.length > 0) throw new DpsIncomplete(problems);
  const p = i.provider, c = i.customer;
  const warnings: string[] = [];
  const city = only(p.cityIbge), cnpj = only(p.cnpj), cDoc = only(c.document);
  const id = dpsId(city, cnpj, i.series, i.number);

  const opSimpNac = p.regime === "mei" ? 2 : p.regime === "simples" ? 3 : 1;
  // regApTribSN só se informa quando o ME/EPP ultrapassou sublimite/limite do Simples (XSD: opcional); o cadastro não coleta isso, então fica de fora e a prévia avisa.
  const regTrib = el("opSimpNac", opSimpNac) + el("regEspTrib", 0);
  const im = xsdText(p.municipalRegistration, 15);
  const prest = `<prest>${el("CNPJ", cnpj)}${im ? el("IM", im) : ""}<regTrib>${regTrib}</regTrib></prest>`;

  let tomaEnd = "";
  if (customerAddressComplete(c.address)) {
    const a = c.address!;
    tomaEnd = `<end><endNac>${el("cMun", only(a.cityIbge))}${el("CEP", only(a.cep))}</endNac>${el("xLgr", xsdText(a.street, 255))}${el("nro", xsdText(a.number, 60))}${xsdText(a.complement, 156) ? el("xCpl", xsdText(a.complement, 156)) : ""}${el("xBairro", xsdText(a.district, 60))}</end>`;
  } else warnings.push("Endereço do cliente incompleto: a nota vai sem endereço do tomador (confira no cadastro do cliente se o município exige).");
  const toma = `<toma>${el(cDoc.length === 11 ? "CPF" : "CNPJ", cDoc)}${el("xNome", xsdText(c.name, 300))}${tomaEnd}</toma>`;

  const serv = `<serv><locPrest>${el("cLocPrestacao", city)}</locPrest><cServ>${el("cTribNac", only(p.tribNacCode))}${el("xDescServ", xsdText(i.service.description, 2000, true))}</cServ></serv>`;

  // Optante do Simples (MEI/ME-EPP) não informa alíquota (vale a do Simples); os demais informam a do ISS (N2b: conferir se o município parametrizado a dispensa).
  if (opSimpNac === 1) warnings.push("Alíquota do ISS e retenção vêm do cadastro da empresa: confirme com o contador e na homologação se o município já traz a alíquota parametrizada (nesse caso ela é dispensada).");
  else if (p.issWithheld) warnings.push("ISS marcado como retido pelo tomador: confira se vale para este cliente e serviço.");
  if (opSimpNac === 3) warnings.push("Simples Nacional ME/EPP: a opção de apuração (regApTribSN) não é informada; só é necessária se a empresa ultrapassou sublimite do Simples. Confirme com o contador.");
  const pAliq = opSimpNac === 1 && p.issRateBps !== null ? el("pAliq", (p.issRateBps / 100).toFixed(2)) : "";
  const trib = `<trib><tribMun>${el("tribISSQN", 1)}${el("tpRetISSQN", p.issWithheld ? 2 : 1)}${pAliq}</tribMun><totTrib>${el("indTotTrib", 0)}</totTrib></trib>`;
  const valores = `<valores><vServPrest>${el("vServ", money(i.service.amountCents))}</vServPrest>${trib}</valores>`;

  const inf = `<infDPS Id="${id}">${el("tpAmb", i.environment)}${el("dhEmi", dhEmi(i.emittedAt))}${el("verAplic", xsdText(i.appVersion, 20))}${el("serie", i.series)}${el("nDPS", i.number)}${el("dCompet", i.competenceDate)}${el("tpEmit", 1)}${el("cLocEmi", city)}${prest}${toma}${serv}${valores}</infDPS>`;
  return { xml: `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">${inf}</DPS>`, id, warnings };
}
