# Revisão Codex — F1 (faturamento automático) e F1b (espelho dos boletos da Cora) — 2026-11-07
Somente leitura. Sem CRITICAL em nenhuma passada.

## F1
- HIGH (corrigido): desligar a chave durante uma rodada não a interrompia → `stillEnabled` conferido antes de gerar prévia, solicitar, processar e criar a fila. Residual aceito: uma rodada de emissão JÁ em andamento (≤ 20 boletos) termina; o freio imediato é «Pausar» (conferido pelo motor ao reservar cada boleto).
- MEDIUM (corrigido): a tela mostrava a data de emissão sem os feriados → `runDateOf` (mesmos feriados do agendador).
- MEDIUM (corrigido): página dizia que o agendador cuida do lote com a chave desligada → mostra «SUSPENSA».
- LOW (corrigido): aviso de emissão podia nascer sem boleto emitido → só entra para hoje se o boleto foi emitido (`issuance_requests.status = 'emitido'`).
- Sem achados: duplicidade de emissão (lock por empresa + SKIP LOCKED + idempotência), migração 0056/reopenBatch, vazamento em audit/logs.

## F1b
- HIGH (corrigido): documento do cliente não era conferido → o DETALHE de todo boleto novo é consultado e o documento conferido; divergência/ausência derruba o cliente inteiro. (Descoberto na Cora real: a listagem não traz o documento; a busca por documento exige início E fim.)
- MEDIUM (corrigido): documentos duplicados após normalização → ficam de fora; paginação sem truncar (teto 60 páginas → `incomplete`, nada gravado); upsert atômico + um cliente por transação; importação diária reservada no banco (advisory lock + marca, vale 3 h).
- HIGH aceito (residual): boleto já espelhado não é revalidado — na Cora o cliente de um boleto não muda e as linhas só entram após a conferência; não há linhas legadas (a primeira importação já roda com a regra).
- Confirmado: nenhum caminho do espelho para cobrança, lote, emissão, escrita na Cora ou fila de mensagens.
