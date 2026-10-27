# Usuários e acessos

**Onde:** menu **Configurações → Usuários e acessos**.

- Cada pessoa tem um papel **por empresa**. Quem não é membro de uma empresa não vê nada dela.
- **Papéis:** Diretoria (gere acessos e vê financeiro), Gerente e Assistente e Contabilidade (veem financeiro), Admin técnico (gere acessos, não vê dados financeiros).
- **Convidar:** informe e-mail e papel. O sistema mostra um link **uma única vez** (com botão **Copiar link**) e, se o envio de e-mail do sistema estiver liberado em Integrações, também envia por e-mail. O link vale 72 h e só funciona uma vez.
- **Primeiro acesso do convidado:** ao abrir o link a pessoa vê a empresa e o papel, escreve o nome, cria a senha (com confirmação, "mostrar senha" e indicador de força) e **já entra**. Quem já tem conta só confirma a senha atual.
- **Convites pendentes:** a lista mostra quem ainda não aceitou. **Novo link** cria outro (o anterior deixa de valer, serve também para convite vencido) e **Cancelar** invalida o convite.
- **Link de nova senha (para um membro):** em cada membro, o botão **Link de nova senha** gera um link de uso único que vale 24 h, mostrado uma vez. Entregue à pessoa por um canal seguro. Diretoria gera para qualquer papel exceto Admin técnico; o Admin técnico gera para papéis abaixo de Diretoria. Quem tem acesso a outra empresa onde você não administra acessos não pode ser redefinido por aqui.
- Diretoria não pode criar Admin técnico. Ninguém remove o próprio acesso.
- **Remover:** o usuário perde o acesso à empresa imediatamente. O histórico fica na auditoria.
- Para trocar de empresa, use o seletor no topo.

## Senha e sessões
**Regras da senha:** mínimo de 12 caracteres; são recusadas senhas só com números (até 15 dígitos), sequências e repetições, as mais comuns e as que contêm o nome do seu e-mail. Uma frase com palavras sem relação funciona bem.

## Verificação em duas etapas (2FA)
Em **Minha conta → Verificação em duas etapas** você liga um segundo passo no login: além da senha, o sistema pede um código de 6 dígitos de um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy, 1Password…). É **recomendado para diretoria e admin técnico**.
1. Informe a senha, copie a **chave** mostrada para o aplicativo (conta do tipo "baseado em tempo") e digite o código que ele gerar.
2. Guarde os **10 códigos de recuperação** (aparecem uma vez só; cada um vale uma vez). Eles servem se você perder o celular.
3. Para **desligar** ou gerar novos códigos, o sistema pede a senha e um código atual.

Errar o código 5 vezes trava o login dessa conta por alguns minutos. O mesmo código não funciona duas vezes. **Perdeu o celular e os códigos?** Quem administra os acessos (Configurações → Usuários → **Remover 2FA**) remove o 2FA da pessoa, que passa a entrar só com a senha e deve ativar de novo; as sessões abertas dela são encerradas. A diretoria remove de qualquer papel; o admin técnico, dos papéis abaixo da diretoria.

## Sessões
Trocar a senha (Minha conta) encerra todas as sessões abertas dessa pessoa, inclusive a atual: entre de novo. Em **Minha conta → Sair em todos os dispositivos** você faz o mesmo sem trocar a senha. Veja também o [Registro de atividades](registro-de-atividades.md).
