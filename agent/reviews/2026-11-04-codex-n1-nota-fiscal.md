# Codex — N1 nota fiscal anexada ao e-mail (2026-11-04)

Escopo: migração 0051 (`charge_invoices`), módulo `src/modules/invoices`, envio real (`runEmailLive`), SMTP (até 2 anexos), tela do lote, download, testes.

## 1ª rodada
- **HIGH 1** — NF removida/trocada entre a consulta final e o `provider.send` → CORRIGIDO: anexar/remover recusam enquanto há e-mail da cobrança em `enviando` (a reserva é commitada antes da reconferência pré-envio; antes do commit a reconferência pega).
- **HIGH 2** — cobrança passa a exigir NF depois da reserva → CORRIGIDO: reconferência de `charges.joint_invoice` imediatamente antes de entregar ao SMTP (volta à fila com `nota_exigida`).
- **MEDIUM** — inserção direta sem validar PDF/hash/estado → CORRIGIDO: CHECKs (cabeçalho `%PDF-`, `sha256` confere, regex do número/código) + gatilho BEFORE INSERT (nasce `ativa`).
- **LOW** — `bodySizeLimit` 3 MB × PDF 2 MiB → sem ação (o corpo do formulário fica abaixo de 3 MB).
- Sem achados: isolamento por empresa, permissões, upload/nome de arquivo/`Content-Disposition`, uma nota ativa por cobrança, auditoria sem dado pessoal.

## 2ª rodada
Ver resultado ao final deste arquivo.
Sem CRITICAL/HIGH/MEDIUM novo. HIGH1 e HIGH2 fechados; MEDIUM fechado. LOW aceitos: (1) janela de milissegundos entre a releitura de `joint_invoice` e o `provider.send` (a exigência só muda reabrindo um lote aprovado, o que o sistema bloqueia com emissão/pagamentos); (2) o CHECK prova estrutura (`%PDF-`, hash), não que o PDF seja uma NFS-e autêntica (responsabilidade de quem anexa). Sem deadlock introduzido (anexar/remover travam só a cobrança, sem os locks da fila).
