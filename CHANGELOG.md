# Changelog

## Pacote inicial — 2026-10-22
- Prompt mestre, PRD, arquitetura, backlog E00–E12, segurança, API, UX, deploy, testes, operação, central de ajuda e memória portátil.
- Nenhuma aplicação iniciada, nenhuma credencial criada, nenhum host alterado e nenhuma integração ativada neste pacote.

## 2026-10-23
- E01: login, shell, dashboard DEMO. E02: papéis por empresa, convites, remoção, auditoria. Publicado via Nginx + Let's Encrypt.
- Segurança (revisão Codex): revalidação de conta por requisição, convite endurecido, rate limit compartilhado. Backup diário + restore testado.
- E03: clientes e fornecedores (CRUD, busca, CNPJ alfanumérico, contatos, histórico, arquivar, importar/exportar CSV). Sandbox `pnpm sandbox`. Seed não altera vínculos existentes.
- E03b: integração CRM (somente leitura): adaptador canônico + mock + HTTP, sincronização com prévia e confirmação por hash, conflitos, cadastros do CRM somente leitura, tela Integrações. Banco realinhado ao desenho (customers/vendors). Protótipo de design (Lovable) revisado.
- Dois cenários de clientes por empresa: Local (padrão) ou CRM (somente leitura). Regra no servidor, serializada com travas; troca auditada; CHECK no banco.
- Fix 1ª sincronização real: prospect não gera conflito de empresa; conflitos que deixam de valer são encerrados (obsolete, sem payload); aviso quando a prévia só tem conflitos; campo "identificação da empresa" explica que deve ficar em branco para o K3G CRM.
