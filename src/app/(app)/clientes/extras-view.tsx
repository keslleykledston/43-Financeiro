export type Extras = { cep: string | null; street: string | null; streetNumber: string | null; complement: string | null; district: string | null; cityName: string | null; cityIbge: string | null; uf: string | null; nfText: string | null; boletoText: string | null };

const cep = (c: string | null) => (c && c.length === 8 ? `${c.slice(0, 5)}-${c.slice(5)}` : c);

/** Somente leitura (papel sem permissão de escrita ou cadastro arquivado). */
export function AddressView({ a }: { a: Extras }) {
  const l1 = [a.street, a.streetNumber, a.complement].filter(Boolean).join(", "), l2 = [a.district, [a.cityName, a.uf].filter(Boolean).join("/"), cep(a.cep)].filter(Boolean).join(" · ");
  return l1 || l2 ? <p className="text-sm">{l1}{l1 && l2 ? <br /> : null}{l2}</p> : <p className="text-sm text-muted-foreground">Endereço não informado.</p>;
}
export function TextsView({ nfText, boletoText }: { nfText: string | null; boletoText: string | null }) {
  return (
    <div className="space-y-3 text-sm">
      <div><p className="text-muted-foreground">Texto da nota fiscal</p><p className="whitespace-pre-wrap">{nfText ?? "— (vale a descrição do contrato)"}</p></div>
      <div><p className="text-muted-foreground">Texto do boleto</p><p className="whitespace-pre-wrap">{boletoText ?? "—"}</p></div>
    </div>
  );
}
