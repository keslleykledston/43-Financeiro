# Codex — WhatsApp W2 (vínculo entre empresas, consentimento/opt-out, bloqueios) — migração 0047
Data: 2026-10-29 · Revisão read-only (Codex 1.0.4). Decisões em `docs/architecture/ADR-whatsapp-001.md`.

| Sev. | Achado | Tratamento |
|---|---|---|
| HIGH | Envio sem opt-in registrado ainda passa (só opt-out bloqueia) | **Não aceito como defeito do TESTE**: o teste é para contato interno autorizado por número (F05 do pacote). Passa a constar na lista de verificação («Sem registro: o TESTE vale pela autorização»); envio a cliente exigirá opt-in nas entregas 3/4 (ADR); teste cobre |
| HIGH | Opt-in global desfaz opt-out global | **Aceito em parte**: reversão continua possível (cliente pode pedir para voltar), mas só diretoria e só com prova escrita/formulário/iniciada pelo cliente; «verbal» recusado; testes |
| MEDIUM | Janela entre última conferência de opt-out e `sendText` | Residual de ms documentada (não se serializa chamada externa com lock de banco); opt-out de última hora já barra depois da consulta do número |
| MEDIUM | `senderIdentity` de empresa alheia visível | Oculto (junto com o nome); teste |
| MEDIUM | Campo da prova aceita PII | `looksLikePii` (e-mail, telefone, CPF/CNPJ, dígitos longos); datas/contratos passam; testes positivos e negativos |
| LOW | Seletor de clientes limitado a 500 | Aceito por ora (filtrado por empresa no servidor); busca/paginação quando houver mais clientes |
| Info | Diretoria de empresa vinculada pode pausar/desconectar a conexão compartilhada | Aviso na tela do cartão e na ajuda |

Achado dos testes (não do Codex): datas vindas de SQL cru chegavam como texto e quebrariam a tela (`toISOString`) → convertidas para `Date` no serviço, com teste.
