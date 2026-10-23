# Segurança e privacidade — requisitos mandatórios

## Princípios
O projeto manipulará valores financeiros, documentos fiscais, dados pessoais e credenciais bancárias. Aplicar minimização de dados, autorização server-side, segurança por padrão, rastreabilidade e segregação entre CNPJs. Respeitar LGPD e definir retenção/DSR junto ao responsável.

## Identidade
- Login individual, convite por admin autorizado, email verificado, senha com hash argon2id ou biblioteca equivalente, logout, reset seguro com expiração, sessão revogável, cookies Secure/HttpOnly/SameSite.
- Rate limit de autenticação, auditoria, MFA recomendado para gestores/administradores, proteção contra sessões simultâneas suspeitas quando necessário.
- Papéis e escopo por empresa aplicados no servidor para páginas, API, jobs, exportação e anexos. Admin TI não herda automaticamente acesso a dados financeiros.
- Sempre testar IDOR, bypass de companyId, URLs compartilhadas e acesso entre CNPJs. Consultas filtradas pelo tenant autorizadas; Group somente agrega companies autorizadas.

## Dados e segredos
- Nunca registrar segredos/tokens em Markdown, Git, logs, screenshots, AI-memory, ferramentas externas, prompts ou ticket. `.env*` ignorados exceto `.env.example`. Prefira secrets do host/Docker com permissões corretas.
- Banco em rede Docker privada, sem published port. TLS externo no Nginx. Ambiente de produção separado do demo/testes e backups criptografados/protegidos.
- Anexos privados com ACL; evitar URLs públicas estáticas de NFs, boletos ou contratos. Tratar logs de e-mail/PII com cuidado. Não registrar payload bruto de webhook sensível.
- Validação Zod, SQL parametrizado, sanitizar HTML de template, proteção XSS/CSRF, upload com tamanho/tipo/AV, limites API, não revelar stacktrace público, SSRF quando importar URLs.
- Auditoria append-only de operações financeiras, aprovações, cadastro de usuários e alterações de alçada.

## Guardrails de operações financeiras reais
Desligado por padrão: emissão de boletos, NF, e-mail a clientes, ordens de pagamento. Exigir flag explícita por ambiente e empresa, permissão humana e checklist de homologação. Read-only em integrações bancárias inicialmente. Nunca usar dados de produção em ferramentas de design / LLM externas.

## Publicação / Nginx
- HTTPS obrigatório antes de login público e financeiro real.
- Antes de alterações: auditar `nginx -T` com cautela (contém configs sensíveis; não colar fora do host), backup do arquivo alterado, `nginx -t`, reload e `curl` de smoke. Escolher porta loopback livre.
- Configuração TLS via certificado válido. Sem `--insecure` persistente, sem desabilitar firewall/SELinux para fazer funcionar. Proteger `/api`, health checks e endpoints administrativos conforme propósito.
- Segredos do app e bancos fora do Git. Revogação imediata se vazados.

## Política de autorização do agente
Autorizado: programar/testar com dados sintéticos, executar lint/build, alterar apenas arquivos específicos do app e vhost com backup e preflight.
Necessita confirmação explícita: limpar DB de produção, enviar cobrança externa, emitir boleto ou NF real, alterar DNS/firewall amplo, habilitar pagamentos, contratar serviços pagos, importar dados pessoais reais, publicar credenciais, migrar destrutivamente.

## Checklist go-live
[ ] auth e RBAC auditados | [ ] tenant isolation tests | [ ] backups restore testado | [ ] TLS válido | [ ] rate limits | [ ] env seguras | [ ] monitoramento | [ ] fluxo de recuperação | [ ] vulnerabilidades P0/P1 zeradas | [ ] homologação Cora/e-NF/e-mail | [ ] responsável financeiro autoriza emissões reais.
