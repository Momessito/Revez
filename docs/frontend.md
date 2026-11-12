# Frontend do Revez

## Auditoria e proposta incremental

O checkout usa HTML, JavaScript ES modules e CSS nativos. O servidor é Node.js 24 com SQLite; não existe backend ASP.NET Core neste repositório. Não há bundler, TypeScript, componentes externos ou SignalR. `public/app.js` concentra autenticação, renderização, SSE e formulários; o CSS anterior contém regras minificadas e sobrescritas repetidas.

Os contratos existentes oferecem um projeto por instância, conversas, mensagens com autoria, contexto versionado, dispositivos da própria conta, convites e ChatGPT. SSE em `/api/events` invalida os dados; não entrega tokens de streaming. `/api/state` e `/api/thread` podem expirar jobs e gravar no banco: não devem ser usados como sondas de leitura de banco.

Problemas encontrados: navegação sem busca; painéis fixos no desktop; ausência de estado de reconexão; perda do rascunho ao trocar de conversa; respostas sem formatação de código; renderizações que substituem elementos focados; falta de catálogo e testes de frontend isolados.

A arquitetura visual usa fundo verde escuro, superfícies discretas e menta reservada a seleção, foco e ação principal. Sidebar de projeto, conversa central, painel contextual com abas e barra de sincronização formam o shell. A visão geral usa somente os dados disponíveis. Membros cadastrados não são apresentados como pessoas online.

### Etapas

1. Fundação: tokens semânticos, primitivas DOM acessíveis, estilos organizados e shell responsivo, preservando JavaScript nativo e os contratos.
2. Experiência central: busca, paleta de comandos, rascunhos por conversa, Markdown seguro, código copiável, painéis recolhíveis/redimensionáveis, estados de carregamento e recuperação, execução e autoria reais.
3. Colaboração futura: presença por membro, projetos múltiplos, permissões de ferramentas, tarefas e diffs dependem de contratos explícitos. Não apresentar dados simulados na aplicação.
4. Qualidade: catálogo Storybook, testes DOM/E2E com API simulada, acessibilidade, teclado e telas pequenas. Os testes de integração SQLite existentes não fazem parte da validação deste trabalho.

## Organização

`public/styles/tokens.css` contém a escala de cores, semântica, tipografia, espaçamento, raios e dimensões. `globals.css` define controles e primitivas; `workspace.css`, o shell e seus estados. `public/components/ui.js` oferece Button, EmptyState, StatusIndicator, CodeBlock e renderização Markdown sem HTML. Inputs, Textarea, Select, Dialog, Tabs, Badge, Avatar, Skeleton, Toast e Tooltip usam elementos HTML nativos e classes documentadas no catálogo. Sidebar, painel redimensionável e paleta permanecem no shell, com estado em `app.js`. `public/lib/api.js` isola HTTP; `workspace-state.js` reúne busca, rascunhos e filtragem de comandos.

Não há migração para React/Tailwind/shadcn: adicionariam um pipeline de produção sem benefício proporcional nesta etapa. Storybook é ferramenta de desenvolvimento e não altera a inicialização do servidor. Inter e JetBrains Mono são distribuídas localmente em WOFF2 latino, com suas licenças OFL em `public/fonts/` e fallback do sistema; nenhuma fonte remota recebe dados da sessão. Para atualizar as fontes, copie os arquivos `*-latin-wght-normal.woff2` dos pacotes Fontsource de desenvolvimento, mantendo as licenças.

### Padrões

- Espaçamento em múltiplos de 4px; foco visível; controles nativos e labels explícitos; `hidden` remove áreas recolhidas do teclado.
- `Ctrl/Cmd+K`: comandos; `Ctrl/Cmd+Shift+O`: conversa; `Ctrl/Cmd+B`: sidebar; `Ctrl/Cmd+Enter`: enviar; Escape fecha overlays. A divisória aceita setas, Home e End.
- Atualizações SSE não substituem composer nem rascunho. O histórico só muda quando seu conteúdo muda e acompanha o final somente se a pessoa já estava próxima dele. Pedidos antigos não mudam a conversa recém-selecionada.
- Markdown é um subconjunto: parágrafos, títulos, listas, citações, ênfase, links HTTP(S) e código. HTML nunca é interpretado. Blocos de código mantêm rolagem e cópia.
- Estados de execução usam apenas `pending`/`running` do contrato. Mensagens finais são `agent` ou `error`. Dispositivos offline não são marcados como agentes com erro.
- Tokens, códigos e credenciais não são salvos nas preferências. Larguras, abas e visibilidade são preferências locais; rascunhos ficam somente na memória e são apagados ao sair.

## Contratos necessários para evolução

| Recurso | Dados e garantias necessários |
| --- | --- |
| Presença | Identificador de membro, heartbeat, expiração, evento de saída; lista de membros atual não fornece presença. |
| Streaming | IDs de execução/mensagem, sequência de deltas, snapshot e cursor para reconexão; SSE atual só invalida dados. |
| Ferramentas e permissões | ID de chamada, responsável, escopo, estado e decisão idempotente autorizada no backend. |
| Arquivos/diffs | Revisão base/final, caminho relativo, diff e autorização de leitura. `checkout` atual só identifica branch/commit. |
| Cancelar/retomar | Transição atômica de execução, autorização por conta, confirmação e idempotência. |
| Projetos/tarefas | IDs, associação de sessões, permissões e paginação/cursor; hoje existe um projeto por instância. |

Novos endpoints devem ser definidos junto ao backend. A interface não inventa rotas para esses recursos. O limite atual do histórico é 150 mensagens, sem paginação: virtualização não resolveria recuperação de histórico anterior; exigir primeiro um contrato de cursor.

## Storyboard

1. Criar workspace: gate → código de configuração → projeto/repositório → workspace.
2. Abrir projeto: visão geral → projeto da instância → conversa existente ou nova conversa; múltiplos projetos ainda não existem.
3. Iniciar agente: conectar computador ou ChatGPT → escolher destinatário/modelo → enviar → acompanhar execução → resposta com contexto usado.
4. Convidar: proprietário → Convidar colega → copiar código temporário → pessoa usa Tenho um convite.
5. Acompanhar: histórico com autoria + estado SSE + aba Execução. Membros não implicam presença online.
6. Revisar: resposta formatada + contexto usado + referência Git; revisão de arquivos permanece no Git até existir contrato de diffs.
7. Continuar: reabrir conversa e enviar novo pedido com contexto publicado. Não há comando de cancelar/retomar no backend.

## Validação

`npm run test:ui` inicia apenas um servidor estático de teste e intercepta `/api/*` no navegador. Fixtures são exclusivas dos testes. Nenhum teste de interface importa `server.mjs`, abre SQLite ou aciona provedores reais. `npm run test:frontend` testa funções puras sem banco. `npm test` continua sendo a suíte original, que grava SQLite, e não deve ser executada sob a política de banco somente leitura.
