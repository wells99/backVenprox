# B14 — Consultas, relatórios e integração com o frontend

**Estado:** planejada. **Dependências:** B01–B13. [Sumário](00-SUMARIO.md). **Telas:** núcleo T00–T14, T21–T23; complementos conectados quando entregues.

## Objetivo e responsabilidade

Trocar fontes fictícias por adaptadores reais sem redesenhar navegação. Aplicação define consultas/abrangência; repositórios retornam projeções autorizadas/indexadas; transporte serializa DTOs B02; frontend converte formatos e mantém apresentação.

Contratos financeiros pertencem ao backend. Funções de demonstração existentes são referência de experiência, não autoridade de cálculo/persistência. Testes por caso de uso já começam nas partes anteriores; esta parte conclui a jornada visual integrada.

## Rotas e cobertura sob /api/v1

| Rota | Finalidade/permissão |
| --- | --- |
| GET /sales; GET /sales/:id | Histórico/detalhe recebidos; filtro e paginação estável |
| GET /sales/:id/reversals | Reversões e restituições autorizadas |
| GET /cash-sessions; GET /cash-sessions/:id | Sessões, fechamento recebido/reconciliado e abrangência |
| GET /cash-sessions/:id/movements | Livro por tipo/meio/origem |
| GET /stock/balances; GET /stock/movements | Consolidado recebido, sem sobrescrever pendência local |
| GET /reports/summary | Totais por período/zona, critérios e cobertura de custo |
| GET /admin/sync-status; GET /admin/sync-status/:device_id | Último estado conhecido, fila reportada, versões e conflitos |

Reutilizar rotas B05–B07; não registrar handlers duplicados. Todas têm schemas OpenAPI e response por permissão, inclusive ocultação de custo. Consultas locais equivalentes via IPC informam scope=terminal/local; web informa scope=store_received.

## Sequência de integração

1. Mapear interfaces de dados das telas e criar portas do frontend: adaptador demo preservado para testes, adaptador IPC Windows e adaptador HTTP web.
2. Converter snake_case/enums/centavos/quantity_milli para modelos da UI; códigos de erro viram mensagens/campos sem analisar texto de message.
3. Substituir IDs demo, número incremental global e operador fake por UUIDs, número CXnn-sequência e contexto autorizado. Nome do terminal/sessão vem do serviço, não constante #26.
4. Conectar T06/T08, depois montagem/pagamento/confirmação, detalhe/reversão/fechamento e cadastros/estoque. Sucesso T04 depende do commit local e mostra envio separadamente.
5. Conectar relatórios/configurações/envios. Remover controles de falha/permissão simulada do caminho operacional; manter somente no ambiente de demonstração.
6. Recarregar/reiniciar não pode apagar dados; consultas reais têm loading/erro/vazio/unknown. Backend indisponível não troca silenciosamente para demo.

## Critérios de relatório

Separar venda bruta pela data da venda, reversões pela data do estorno e líquido do movimento; explicitar diferença para posição atual de vendas antigas. Ticket médio usa numerador/denominador do mesmo conjunto. Sessão que cruza meia-noite não perde identidade.

Recebimentos por meio são movimentos: fiado com caixa separado das novas vendas, sem caixa fora do total; lembretes fora do financeiro. Gaveta apenas dinheiro. Custo desconhecido conserva null/indicador, sem lucro fictício; resultado bruto estimado informa cobertura e não equivale a lucro líquido.

Devolver fonte, período/fuso e as_of, com contato por terminal. Ausência de contato ou fila ilegível não é zero pendências. Paginação por chave estável, limite máximo, ordenação permitida e consulta parametrizada. Exportação pesada segue job B13, não conexão de leitura indefinida.

## Critérios para FEITO

Jornada real: abrir caixa → vender por teclado → reiniciar offline → sincronizar → encontrar na web → cancelar/fechar e conferir livros. Preservar foco, setas de pagamento, F2 e contexto de retorno já implementados.

Conciliar relatórios por IDs/totais com o banco, incluindo estorno em dia posterior, avulso/custo desconhecido e três terminais com um offline. Testar isolamento/permissão na consulta, paginação concorrente, limites de período e falha do serviço sem fallback falso.

Registrar matriz tela → comando/rota → estado real, evidências e pendências. **Próxima recomendada:** B15, ou B18 se complementos forem adiados. Base: [frontend](../../docs/frontend.md), [roteiro atual](../../front-Venprox/PLANO-DE-TELAS.md), [backend §4.4](../../docs/backend.md).
