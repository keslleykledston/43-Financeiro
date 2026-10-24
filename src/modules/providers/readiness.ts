import { existsSync } from "node:fs";
import { LIVE_FLAGS, liveFlagsOn } from "./registry";

/**
 * E10 — checklist do GATE de emissão real. Só verifica EXISTÊNCIA de arquivos de segredo e o estado das chaves; nunca lê conteúdo.
 * Segredos ficam fora do Git, em arquivos montados somente-leitura em /run/secrets (ver docs/E10_GOLIVE.md).
 */
export type CheckState = "ok" | "pendente" | "alerta";
export type ReadinessItem = { key: string; label: string; state: CheckState; detail: string };

const SECRET_DIR = process.env.K3G_SECRETS_DIR ?? "/run/secrets";
const has = (f: string) => existsSync(`${SECRET_DIR}/${f}`);

export function readiness(env: Record<string, string | undefined> = process.env, opts: { coraInDb?: boolean; emailInDb?: boolean; fiscalComplete?: boolean } = {}): ReadinessItem[] {
  const live = liveFlagsOn(env);
  const human = (key: string, label: string, detail: string): ReadinessItem => ({ key, label, state: "pendente", detail });
  return [
    { key: "flags", label: "Chaves de emissão/envio reais desligadas", state: live.length === 0 ? "ok" : "alerta", detail: live.length === 0 ? `${LIVE_FLAGS.length} chaves, todas desligadas` : `Ligadas sem adaptador homologado: ${live.join(", ")}` },
    { key: "cora-creds", label: "Credenciais Cora (client-id, certificado e chave mTLS)", state: opts.coraInDb || (has("cora_client_id") && has("cora_cert.pem") && has("cora_key.pem")) ? "ok" : "pendente", detail: "Cadastradas na seção «Cora — boletos» desta tela (guardadas cifradas) ou como arquivos cora_client_id, cora_cert.pem e cora_key.pem em /run/secrets. Ter as credenciais NÃO liga a emissão real" },
    { key: "smtp-creds", label: "Credenciais SMTP do domínio", state: opts.emailInDb || (has("smtp_user") && has("smtp_password")) ? "ok" : "pendente", detail: "Conta cadastrada na seção «E-mail (SMTP)» desta tela (guardada cifrada) ou arquivos smtp_user e smtp_password em /run/secrets. Ter a conta NÃO liga o envio real" },
    { key: "waha-creds", label: "Chave do WAHA (WhatsApp)", state: has("waha_api_key") ? "ok" : "pendente", detail: "Arquivo waha_api_key em /run/secrets" },
    { key: "fiscal-profile", label: "Dados fiscais da empresa para a NFS-e preenchidos", state: opts.fiscalComplete ? "ok" : "pendente", detail: "Empresa → Dados fiscais: regime, inscrição municipal, CNAE, código do serviço, alíquota do ISS e endereço (confirmar com o contador)" },
    human("homolog-cora", "Homologação Cora concluída", "Emitir e consultar boleto (e segunda via) em ambiente de testes e anexar o resultado"),
    human("nfse-cover", "Cobertura da NFS-e da Cora confirmada", "Município, CNAEs e regime tributário dos dois CNPJs"),
    human("fiscal-calendar", "Calendário fiscal aprovado", "Regras de emissão revisadas por quem responde pela contabilidade"),
    human("dns-mail", "SPF, DKIM e DMARC do domínio de e-mail", "Remetente por empresa e tratamento de devolução (bounce)"),
    human("optin", "Lista de WhatsApp com opt-in revisada", "Número dedicado, janelas e limites de envio aprovados"),
    human("authorization", "Autorização explícita da diretoria", "Por provedor e por empresa, com limites de envio, registrada por escrito"),
  ];
}
