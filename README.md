# Revez

Piloto local para compartilhar conversas e contexto de projeto entre pessoas que usam agentes de código. O servidor mantém contas, mensagens e versões em SQLite. Cada pessoa pode conectar mais de um computador e escolher onde cada rodada local roda. Veja a [arquitetura](ARCHITECTURE.md).

## Iniciar o workspace

1. Instale ou use Node.js 24 ou mais recente e Git. O servidor usa módulos do Node e dispensa `npm install`.
2. Na pasta extraída, execute `npm start` ou `node server.mjs`.
3. Abra `http://127.0.0.1:8788` e crie a primeira conta com o código de configuração exibido no terminal. Em **Repositório**, informe `equipe/projeto`. Esse nome identifica o projeto. Cada pessoa escolhe o clone local ao conectar seu agente.
4. Em **Convidar colega**, copie o código e entregue-o à pessoa. Ela entra em **Tenho um convite** e cria a própria conta. Para testar no mesmo computador, abra uma janela anônima ou outro perfil de navegador.

Por padrão o servidor escuta apenas no próprio computador e usa `.data/revez.sqlite`. Um piloto em dois dispositivos precisa de um endereço HTTPS alcançável pelos dois. Configure um proxy TLS com suporte a SSE à frente do Node e defina `REVEZ_ORIGIN` com a origem HTTPS exata usada no navegador. `REVEZ_PORT` altera a porta interna. Use `REVEZ_BIND` somente quando o proxy precisar alcançar o Node fora do loopback.

## Usar o ChatGPT direto no Revez

1. Abra o Revez em `http://127.0.0.1:8788` no seu navegador e entre no workspace.
2. Clique em **Conectar ChatGPT → Continuar com ChatGPT**. Autorize o uso do seu plano na página da OpenAI. O navegador volta ao Revez.
3. Selecione **ChatGPT** como destinatário, escolha um modelo da lista do seu plano e envie a mensagem. A rodada recebe o contexto publicado e o histórico recente da tarefa. A resposta aparece para a equipe com a versão do contexto usada.

Essa conexão usa o fluxo oficial para projetos locais com planos elegíveis. Ela dispensa a CLI, códigos de pareamento e chaves de API. O chat nativo usa o material compartilhado no Revez. Para consultar arquivos no clone, use o OpenCode local da seção seguinte.

As credenciais do ChatGPT ficam na memória do processo local e o Revez preserva o registro da conexão no SQLite. Ao reiniciar o servidor, clique em **Conectar ChatGPT** para reautorizar. Para atualizar uma instalação existente, substitua os arquivos do app na mesma pasta e preserve `.data/`, que contém o workspace.

O login nativo fica disponível no modo local com `REVEZ_ORIGIN=http://127.0.0.1:<porta>`. Para oferecer uso de planos em um SaaS pago ou hospedado, solicite acesso comercial no programa [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source).

## Conectar o OpenCode local

O piloto usa a CLI OpenCode v1. Use a versão 1.18.35 ou outra versão 1.x compatível com `run --pure --format json`. Configure seu provedor no OpenCode e use `opencode models` para identificar o modelo. No Windows, o runner encontra o executável de instalações npm comuns. Se preciso, informe em `REVEZ_OPENCODE` o caminho completo de `opencode.exe`.

Para testar com seu plano ChatGPT Plus ou Pro, execute `opencode --pure auth login --provider openai` e escolha **ChatGPT Pro/Plus (browser)**. Complete o login no navegador e rode `opencode --pure models openai`. Use um dos IDs `openai/...` exibidos em `REVEZ_MODEL`. Se estiver reaproveitando um terminal usado com Ollama, execute `Remove-Item Env:REVEZ_OPENCODE_CONFIG -ErrorAction SilentlyContinue` antes de iniciar o runner.

Abra **Meus computadores**, informe um nome, como `Notebook`, e clique em **Gerar código**. No PowerShell 7, no computador escolhido e dentro da pasta do Revez:

```powershell
$env:REVEZ_URL = 'http://127.0.0.1:8788'
$env:REVEZ_MODEL = 'provedor/modelo'
$env:REVEZ_RUNNER_TOKEN = Read-Host 'Código do agente' -MaskInput
node runner.mjs 'C:\caminho\para\seu\clone'
```

Em shells POSIX, defina as mesmas três variáveis de ambiente e execute `node runner.mjs /caminho/para/seu/clone`. Para Ollama local com `qwen3-coder:30b` já instalado, use `REVEZ_MODEL=ollama-local/qwen3-coder:30b` e aponte `REVEZ_OPENCODE_CONFIG` para `ollama.example.json`. Ajuste o exemplo se usar outro modelo local.

Repita com um código novo para cada computador ou clone que quiser conectar. Selecione **Meu agente local** e escolha o computador na conversa. O Revez mostra seu modelo, branch e commit, e roda uma tarefa por computador de cada vez. Para desligar um destino, use **Meus computadores → Revogar**. O código é uma credencial do runner; guarde-o no computador escolhido. Ao atualizar, o código anterior aparece como **Agente anterior** e continua válido. Atualize também `runner.mjs` antes de parear novos computadores.

A chave ou sessão do provedor fica na instalação local. Pedidos e respostas entram no histórico visível à equipe, com o nome do computador e a revisão Git selecionada. O provedor recebe o pedido, a versão do contexto, as mensagens recentes e os dados que o agente ler do clone durante a rodada.

## Testar a colaboração

1. Na primeira conta, abra uma conversa, clique em **Atualizar** e publique uma decisão, um próximo passo e uma referência Git.
2. Na segunda conta, aguarde a versão aparecer. Selecione **Meu agente local**, escolha um computador conectado e peça para continuar a tarefa.
3. A resposta indica a versão usada. Abra **Ver contexto vN usado** para conferir o conteúdo que acompanhou o pedido. Uma atualização publicada durante a rodada vale para o pedido seguinte.

Para testar dois destinos na mesma conta, abra dois terminais, use um código diferente em cada um e aponte os runners para clones distintos. Escolha os destinos na conversa. O runner verifica a branch e o commit antes e depois da execução. Se a revisão mudar, confira o destino e envie novamente. Essa verificação acompanha o `HEAD`; alterações locais sem commit continuam no clone. Esta etapa cobre leitura e planejamento. Alterações de código, troca de branch, PRs e sincronização de arquivos continuam no Git.

`npm test` verifica colaboração entre contas, dois destinos simulados na mesma conta, revogação, mudança de revisão, migração do banco e login nativo do ChatGPT com um provedor simulado. Para testar com sua conta real, autorize o Revez pelo botão e faça uma rodada no chat.
