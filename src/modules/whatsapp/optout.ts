/**
 * W3b — reconhece o PEDIDO DE PARAR numa resposta de cliente. Funções PURAS. Regra do pacote: «PARAR», «SAIR», «CANCELAR», «NÃO ME ENVIE» e intenção inequívoca = pedido de parar;
 * caso ambíguo vai para humano E o bloqueio é conservador (na dúvida, bloqueia). Normaliza caixa, acento, pontuação e emoji. Nunca responde nada ao cliente.
 */
export type InboundClass = "opt_out" | "opt_out_ambiguo" | "resposta";

export const normalizeText = (s: string): string => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

// frases inequívocas (texto já normalizado, sem pontuação)
const CLEAR = new Set([
  "parar", "pare", "sair", "stop", "cancelar", "remover", "descadastrar", "descadastro", "nao quero", "nao quero receber", "nao me envie", "nao me envie mais", "nao envie mais", "nao me mande", "nao me mande mais",
  "nao mande mais", "parar de receber", "pare de enviar", "pare de mandar", "nao quero mais", "nao quero mais receber", "nao quero receber mais", "nao quero mais mensagens", "sair da lista", "cancelar mensagens",
  "parar mensagens", "parar avisos", "nao enviar mais", "nao me envie mais nada", "nao me envie nenhuma mensagem", "nao quero nenhuma mensagem",
]);
const FILLER = /\b(por favor|pf|pfv|obrigado|obrigada|valeu|ok|certo)\b/g;
// qualquer sinal de intenção de parar/recusar (decide «ambíguo» quando não é inequívoco)
const SIGNAL = /\b(parar|pare|parem|sair|stop|cancelar|cancele|cancelem|remover|remova|descadastr\w*|bloquear|bloqueio|denunciar|denuncia|spam|incomod\w*|chega|nao quero|nao me (envie|mande|mand\w*|ench\w*|perturbe)|nao envie|nao mande)\b/;
// palavras que mostram que o assunto é OUTRO (contrato, boleto...) e o «cancelar» não é sobre as mensagens
const OTHER_TOPIC = /\b(contrato|servico|plano|assinatura|boleto|cobranca|pagamento|fatura|nota|link|internet)\b/;
// frases que pedem para parar TUDO, de todas as empresas
const ALL = /\b(todas?|nenhuma empresa|nada|ninguem|nenhum aviso|nenhuma mensagem)\b/;

export function classifyInbound(raw: string): InboundClass {
  const t = normalizeText(raw);
  if (!t) return "resposta";
  const stripped = t.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  if (CLEAR.has(stripped)) return "opt_out";
  // «parar/pare/sair/stop» + até 3 palavras de complemento sobre receber/enviar/mensagens
  if (/^(parar|pare|sair|stop|cancelar)( de)?( me)?( receber| enviar| mandar)?( as| os| suas| seus| mais)?( mensagens?| avisos?| notificacoes| cobrancas?| lembretes?)?( mais)?( aqui| por aqui| no whatsapp| neste numero)?$/.test(stripped)) return "opt_out";
  if (/^nao (me )?(envie|mande|quero receber)( mais)?( nada| mensagens?| avisos?| cobrancas?)?( mais)?( aqui| por aqui| no whatsapp)?$/.test(stripped)) return "opt_out";
  if (SIGNAL.test(t)) return "opt_out_ambiguo";
  return "resposta";
}

/** O pedido vale para TODAS as empresas do número? («não me envie nada/nenhuma mensagem», «todas»). */
export const asksAll = (raw: string): boolean => ALL.test(normalizeText(raw)) && SIGNAL.test(normalizeText(raw));
export const mentionsOtherTopic = (raw: string): boolean => OTHER_TOPIC.test(normalizeText(raw));
