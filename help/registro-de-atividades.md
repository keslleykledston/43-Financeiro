# Registro de atividades

**Quem acessa:** diretoria e admin técnico. Os demais papéis não veem a tela.
**Onde:** **Configurações → Registro de atividades** (ou `/auditoria`).

## Para que serve
Mostra **quem fez o quê e quando** na empresa selecionada: entradas no sistema, trocas de senha, convites, contratos criados ou importados, lotes aprovados, pagamentos registrados, conciliações. Serve para conferir uma alteração e para investigar qualquer coisa estranha.

## Como usar
1. Abra a tela: as atividades mais recentes aparecem primeiro, 50 por página.
2. Filtre por **tipo de ação** (o começo do código, por exemplo `contract` ou `auth`), por **quem** fez e por **período** (dias no horário de Manaus).
3. Use **Mais antigas →** e **← Mais recentes** para navegar.

## O que aparece (e o que nunca aparece)
- Cada linha tem o nome legível da ação, quem fez, o código técnico e um resumo curto com identificadores e contagens (por exemplo, quantos contratos um lote tinha).
- **Nunca** são gravados nem mostrados senhas, chaves, tokens ou conteúdo de arquivos. Se algum campo tiver cara de segredo, a tela mostra `••••`.
- Eventos de conta (entrar, trocar senha, encerrar sessões) aparecem para as empresas das quais a pessoa é membro ativa.
- O registro é só leitura: ninguém edita nem apaga pela tela.

## Relacionado: encerrar sessões
Em **Minha conta** há duas formas de derrubar o acesso aberto em todos os aparelhos:
- **Trocar a senha** encerra todas as sessões, inclusive a atual; entre de novo com a senha nova.
- **Sair em todos os dispositivos** faz o mesmo sem trocar a senha (útil se esqueceu aberto em um computador alheio).

## Erros comuns
- *“Seu papel não tem acesso ao registro de atividades.”* Peça à diretoria.
- *Não achei a ação que procuro.* O filtro vale para o **começo** do código; apague o filtro e use o período.

Última atualização: 2026-10-24.
