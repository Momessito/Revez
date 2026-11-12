# Arquitetura do Revez

O workspace guarda o contexto que a equipe compartilha. Cada pessoa conecta seu próprio provedor e decide onde roda uma solicitação. Para continuar o trabalho de um colega, a pessoa abre a mesma conversa e chama sua própria IA. O Revez inclui a revisão publicada do contexto, até oito mensagens recentes e o pedido atual. O contexto publicado durante uma rodada só entra nos próximos pedidos.

| Componente | Responsabilidade |
| --- | --- |
| Navegador | Conversas, versões de contexto, seleção do destinatário e gestão dos computadores da conta. |
| Servidor Revez | Sessões, acesso ao workspace, roteamento das rodadas, histórico e atualização da interface por SSE. |
| SQLite | Contas, conversas, versões, computadores, fila e referência Git de cada rodada local. |
| Runner local | Consulta as próprias rodadas, verifica a revisão Git, executa o OpenCode em modo de leitura e publica o resultado. |
| ChatGPT nativo | No Revez local, usa o modelo da conta conectada pelo fluxo próprio de autorização. A rodada não usa um clone e pode coexistir com rodadas locais. |

## Uma rodada local

1. A conta emite um código exclusivo para um computador. O servidor armazena o hash do código. No primeiro contato do runner atualizado, a conexão é vinculada ao identificador do clone, derivado no computador sem enviar o caminho.
2. Ao enviar, o servidor confirma que o destino pertence à conta e está conectado. Registra a mensagem e a rodada na mesma transação, com o modelo, a branch, o commit e a revisão de contexto selecionados. Cada computador tem uma rodada ativa por vez.
3. O runner consulta o servidor. Só recebe rodadas dirigidas ao código que apresentou. Se o modelo ou a revisão Git reportados mudaram desde o envio, a rodada termina com um aviso. Ao entregar a rodada, o servidor emite uma autorização temporária para publicar o resultado.
4. O runner verifica branch e commit antes e depois da execução. A resposta leva o nome do destino e a revisão de contexto ao histórico. Repetir a entrega do mesmo resultado não duplica a resposta. O Revez não cria um snapshot de arquivos locais sem commit.
5. A revogação invalida o código e termina as rodadas em aberto daquele computador. O histórico e os outros destinos continuam disponíveis. Um resultado atrasado de um código revogado é rejeitado.

## Evolução

Esta versão mantém um workspace por instância, um processo de servidor, SQLite e consulta periódica pelo runner. A migração reaproveita o código anterior como um primeiro computador. Uma rodada pendente tem prazo para ser recebida; após ser entregue, tem prazo fixo para terminar. Se o prazo expirar, a pessoa pode enviar de novo.

O próximo passo é separar vários projetos e seus clones dentro do workspace. Depois, vale acrescentar recuperação explícita de rodadas interrompidas, um contrato comum para outros agentes e permissões próprias para qualquer execução que possa editar arquivos. O histórico compartilhado não dá acesso aos computadores ou às assinaturas de outros integrantes.
