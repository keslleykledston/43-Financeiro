import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";

/** .pfx de TESTE (chave gerada na hora; nada real). `cnpj` vai no CN no padrão e-CNPJ ICP-Brasil: «NOME:00000000000000». */
export function makePfx(o: { cn?: string; password?: string; notBefore?: Date; notAfter?: Date; withCa?: boolean; icp?: boolean } = {}): Buffer {
  const pw = o.password ?? "senha-de-teste";
  const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const priv = forge.pki.privateKeyFromPem(kp.privateKey.export({ type: "pkcs1", format: "pem" }) as string) as forge.pki.rsa.PrivateKey;
  const pub = forge.pki.publicKeyFromPem(kp.publicKey.export({ type: "spki", format: "pem" }) as string) as forge.pki.rsa.PublicKey;
  const mk = (cn: string, issuerCn: string, key: forge.pki.rsa.PrivateKey, pubKey: forge.pki.rsa.PublicKey) => {
    const c = forge.pki.createCertificate();
    c.publicKey = pubKey; c.serialNumber = "01" + Math.floor(Math.random() * 1e9).toString(16);
    c.validity.notBefore = o.notBefore ?? new Date(Date.now() - 86_400_000); c.validity.notAfter = o.notAfter ?? new Date(Date.now() + 200 * 86_400_000);
    c.setSubject([{ name: "commonName", value: cn }, ...(o.icp === false ? [] : [{ name: "organizationName", value: "ICP-Brasil" }])]);
    c.setIssuer([{ name: "commonName", value: issuerCn }, ...(o.icp === false ? [] : [{ name: "organizationName", value: "ICP-Brasil" }])]);
    c.sign(key, forge.md.sha256.create());
    return c;
  };
  const cert = mk(o.cn ?? "EMPRESA TESTE LTDA:11222333000181", o.withCa ? "AC TESTE" : (o.cn ?? "EMPRESA TESTE LTDA:11222333000181"), priv, pub);
  const certs = [cert];
  if (o.withCa) { const ca = generateKeyPairSync("rsa", { modulusLength: 2048 }); certs.push(mk("AC TESTE", "AC TESTE", forge.pki.privateKeyFromPem(ca.privateKey.export({ type: "pkcs1", format: "pem" }) as string) as forge.pki.rsa.PrivateKey, forge.pki.publicKeyFromPem(ca.publicKey.export({ type: "spki", format: "pem" }) as string) as forge.pki.rsa.PublicKey)); }
  const p12 = forge.pkcs12.toPkcs12Asn1(priv, certs, pw, { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
}
