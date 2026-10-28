/** Erros que os adaptadores reais usam para falar com o motor de emissão (o motor decide pelo `name`). */
/** Provedor não respondeu / conexão caiu depois do envio: a emissão PODE ter acontecido. */
export class IssuanceTimeout extends Error { constructor() { super("timeout"); this.name = "IssuanceTimeout"; } }
/** Recusa explícita ANTES de processar (ex.: HTTP 429 com garantia de que nada foi criado): seguro repetir com backoff. */
export class IssuanceRetryable extends Error { constructor(msg = "retryable") { super(msg); this.name = "IssuanceRetryable"; } }
