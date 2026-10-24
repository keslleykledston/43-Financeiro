# Cora — boletos (credenciais)

**Quem acessa:** somente a **diretoria**. **Onde:** menu *Integrações* → seção **Cora — boletos**.

## O que a integração faz e não faz
- **Faz:** emitir boleto, consultar a situação (emitido, pago, atrasado), emitir segunda via e **cancelar boleto**.
- **Cancelar boleto é só da diretoria**, com motivo obrigatório, e fica tudo registrado (quem, quando, por quê e o resultado). Só cancela boleto emitido e ainda sem pagamento. A tela de cancelamento chega na próxima fase (E20); hoje a permissão e o limite já existem.
- **Nunca faz:** pagar contas ou boletos, transferir, enviar Pix, ler saldo ou extrato da conta. A plataforma **não movimenta dinheiro** da conta. Quem foi pago e quando vem da situação do próprio boleto.

## Cadastrar as credenciais
1. Na Cora, crie a **integração direta** (API) e anote o **Client ID**; baixe o **certificado** e a **chave privada**. Se a Cora deixar escolher permissões, marque só o que é de boletos.
2. Aqui, escolha o **ambiente**: *Homologação* (testes) ou *Produção*. Cada ambiente tem suas próprias credenciais, por empresa (K3G Solutions e K3G Call separadas).
3. Preencha o Client ID e **cole** o certificado e a chave (ou envie os arquivos `.pem`). Toque em **Guardar credenciais**.

O sistema confere antes de guardar: certificado dentro da validade, chave **sem senha** e que **combina** com o certificado. Se não passar, nada é guardado e a mensagem diz o motivo.

## Como os dados são protegidos
- Ficam **cifrados** no servidor; ninguém consegue ler a chave pelo sistema, nem a diretoria. A tela mostra só o **apelido**, uma **impressão digital** do certificado e a **validade**.
- Para trocar, guarde de novo (substitui). Para apagar, **Remover**.
- Cada guardar/remover entra no *Registro de atividades*, sem os dados.
- Nunca mande estes dados por chat, e-mail ou Git. Se vazarem, gere novos na Cora e substitua aqui.
- Se a chave de segurança do servidor for trocada, os dados guardados deixam de abrir e é preciso cadastrar de novo.

## Guardar não liga a emissão
Cadastrar as credenciais **não emite nada**. A emissão real continua desligada até a homologação e a **autorização escrita da diretoria** (checklist *Portão da emissão real*). Hoje todos os boletos são simulados.

## Aviso de vencimento
O certificado tem validade: a seção avisa quando faltam 30 dias ou menos e marca **Vencido**. Gere um novo na Cora antes disso.
