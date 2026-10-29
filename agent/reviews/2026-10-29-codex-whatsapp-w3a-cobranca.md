# Codex — WhatsApp W3a (cobrança de cliente, manual e assistida; fila cifrada) — migração 0048
Data: 2026-10-29 · Revisão read-only (Codex 1.0.4). Decisões: `docs/architecture/ADR-whatsapp-001.md` (seção «Entrega 3a»).

| Sev. | Achado | Tratamento |
|---|---|---|
| HIGH | Corrida na regra «1 aviso por cliente a cada 7 dias» (duas cobranças do mesmo cliente passavam pela checagem antes da trava) | Revalidada **dentro da trava**, na reserva; a segunda é suprimida (`aviso_recente`) fora da transação (a 1ª versão gravava dentro e o `throw` desfazia: pego pelo teste); teste de concorrência com duas cobranças do mesmo cliente |
| HIGH | Pagamento/opt-out depois da última reconferência e antes do `sendText` | **Aceito e documentado:** chamada externa não se serializa com transação do banco; a janela é só o intervalo entre `recheckAfterCheck` e `sendText` (ms). A mensagem em «enviando» não é suprimida por pagamento (já saiu) |
| HIGH | Outbox presa em `enviando` sem reconciliação | `settleStaleSends` também encerra a fila de cobranças (>10 min → `desconhecido`, sem reenvio, só diretoria); aviso e botão no histórico; conferência humana resolve; teste |
| HIGH | Cancelar só o boleto suprimia mensagem de cobrança ainda devida | `cancelQueueForCharges(..., { keepWhatsapp })`: cancelamento de boleto (e cancelado no provedor) **não** suprime; pagamento, lote reaberto/cancelado suprimem; teste |
| MEDIUM | Desligar a empresa deixava a fila para sair depois de religar | Desligar **suprime** o que está na fila (`empresa_desligada`); teste |
| MEDIUM | Gatilho não restringe `desconhecido → enviado/falhou` a `resolveUnknown` | Documentado: a regra de quem resolve é do serviço (permissão `whatsapp.authorize`); o banco garante só a máquina de estados e a imutabilidade (único papel SQL da aplicação) |
| MEDIUM | Testes não cobriam a corrida entre cobranças distintas nem a reserva abandonada | Cobertos (4 testes novos) |
Sem CRITICAL. Isolamento por empresa, cifra com contexto por empresa e ausência de telefone/texto em auditoria verificados pelo revisor.
