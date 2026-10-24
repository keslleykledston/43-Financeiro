import { isIPv4, isIPv6 } from "node:net";

/**
 * E23 — proteção contra SSRF no envio real: o servidor SMTP é digitado por uma pessoa e o sistema se conecta a ele. O nome é resolvido AQUI
 * e só se conecta a endereço PÚBLICO (o IP validado é o mesmo usado na conexão, então um DNS que muda depois — rebinding — não vale).
 * Funções PURAS (sem rede).
 */
const v4 = (ip: string): number[] => ip.split(".").map(Number);
const inV4 = (n: number[], base: number[], bits: number) => {
  const a = ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0, b = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
};
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** Expande IPv6 para 8 grupos de 16 bits (aceita "::" e v4 embutido no fim). null se inválido. */
function groups6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) { if (!isIPv4(m[1])) return null; const o = v4(m[1]); s = s.slice(0, -m[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16); }
  const [head, tail, extra] = s.split("::");
  if (extra !== undefined) return null;
  const h = head ? head.split(":") : [], t = tail === undefined ? [] : tail ? tail.split(":") : [];
  if (tail === undefined ? h.length !== 8 : h.length + t.length > 7) return null;
  const all = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  const g = all.map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return g.length === 8 && g.every((x) => !Number.isNaN(x)) ? g : null;
}

/** true = NÃO pode ser usado como destino do SMTP (privado, loopback, link-local, reservado, multicast…) ou não é um IP válido. */
export function isForbiddenIp(ip: string): boolean {
  if (isIPv4(ip)) { const n = v4(ip); return BLOCKED_V4.some(([b, bits]) => inV4(n, v4(b), bits)); }
  if (!isIPv6(ip)) return true;
  const g = groups6(ip);
  if (!g) return true;
  const embedded = (a: number, b: number) => isForbiddenIp(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  if (g.every((x, i) => (i < 7 ? x === 0 : x <= 1))) return true; // :: e ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentação
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded(g[6], g[7]); // ::ffff:a.b.c.d e ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return embedded(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4
  return false;
}

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

/** Resolve o nome e devolve UM endereço público. Lança se qualquer resposta for proibida (não escolhe "o bom": uma resposta suspeita invalida o nome). */
export async function resolvePublicAddress(host: string, lookup: Lookup): Promise<{ address: string; family: number }> {
  const all = await lookup(host);
  if (all.length === 0) throw new Error("dns_sem_resposta");
  if (all.some((a) => isForbiddenIp(a.address))) throw new Error("servidor_interno_bloqueado");
  return all.find((a) => a.family === 4) ?? all[0];
}
