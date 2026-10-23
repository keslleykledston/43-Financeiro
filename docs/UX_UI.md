# Design system e UX — iOS-inspired, original, K3G

## Princípios
Aparência tecnológica, discreta, profissional, com referências ao refinamento visual do iOS, **sem copiar logos, ícones proprietários ou telas da Apple**. Menos cliques, leitura rápida e baixa carga cognitiva. Produtos financeiros não podem esconder informações críticas por estética.

## Paleta e componentes
- Layout base com background cinza muito claro ou grafite controlado, superfícies brancas/escurecidas, bordas sutis, shadows minimalistas e glass apenas onde não prejudicar legibilidade.
- 1 cor de acento escolhida pelo agente (azul petróleo/ciano suave), sem arco-íris de badges; cores semânticas para erro, sucesso e alertas com ícones/texto.
- Font stack system (San Francisco onde disponível nativamente, fontes abertas alternativas; não empacotar fontes proprietárias). Radius 12–20px nos cards, spacing modular 4/8/12/16/24/32.
- Cards de indicadores com valor, período, fonte e atualização; não tratar dados demo como reais.
- Sidebar compacta desktop; bottom nav ou drawer acessível mobile; seletor de empresa persistido em preferência do usuário e escopo validado no backend.
- Tabelas densas mas legíveis com filtros, busca, seleção, paginação, ações contextuais; mobile em cards, não tabela horizontal ilegível.
- Feedback: loading/skeleton, empty state com CTA, sucesso com ação rastreável, erro com orientação, confirmação em ações irreversíveis.
- Templates editor e previews acessíveis; datas e moeda pt-BR, timezone `America/Manaus` explicitamente; teclado completo, foco visível, contrast WCAG AA, `prefers-reduced-motion`.
- Ajuda contextual com ícone `?` e atalhos para `help/`, acessível dentro do shell autenticado.

## Primeira tela de dashboard
Cabeçalho K3G Finance + empresa selecionada, período e data da atualização. 4 KPIs principais: a receber, a pagar, recebimentos do mês, saldo disponível (quando bancário real ainda indisponível mostrar `não conectado`, NUNCA valor aleatório não identificado). Gráfico receita x recebimento e lista 'precisa de atenção' por prioridade. Estado demo com faixa persistente “AMBIENTE DEMO — DADOS FICTÍCIOS”. Ações rápidas: novo cliente, novo contrato, simular lote. Sem popup de marketing ou métricas falsas.

## MCP Lovable
Solicitar de preferência componentes prontos para React/Tailwind/shadcn; se ferramenta criar projeto remoto, extrair apenas código e recursos permitidos para repositório local. Exportar referências/diffs revisados. Dados sempre sintéticos. Se MCP não estiver disponível, seguir com design system local sem bloquear.

## Critério visual de aceite
375px/768px/1440px, teclado, hover/focus, light e opcional dark, estados vazios/carregando/erro, Lighthouse a11y pragmático, screenshots em `agent/reviews` ou `docs/assets` sem dados privados.
