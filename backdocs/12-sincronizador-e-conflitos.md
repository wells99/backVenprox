# B12 — Sincronizador local e conflitos

**Estado:** planejada. **Dependências:** B01–B11. [Sumário](00-SUMARIO.md). **Telas:** origem do status real T23; mantém atendimento T02/T03 independente da rede.

## Objetivo e camadas

Executar o ciclo durável do terminal: compatibilidade → download → envio ordenado → recibos → download. Aplicação coordena política/dependências; infraestrutura faz HTTPS, agenda e acesso à fila; domínio preserva fatos. Nunca trocar o caminho de gravação local por remoto quando a internet volta.

Dados locais: outbox_operations, sync_state, sync_conflicts, catálogo-base e propostas pendentes. Estados pending, sending, acknowledged, retry_wait, conflict e blocked; reinício de sending recupera elegibilidade mantendo ID/hash/conteúdo.

## Sequência

1. Conferir API/protocolo e identidade, não somente rede ativa do Windows. Renovação de terminal é separada do login da interface.
2. Baixar mudanças e aplicar página + cursor numa transação. Reconhecer origem própria e unique de movimento: o que já baixou localmente não baixa outra vez.
3. Enviar próxima operação contígua do device, uma em voo por vez inicialmente; lote é otimização de transporte, sem quebrar ordem/dependências.
4. Verificar recibo individual: origem, ID, sequência e hash. Confirmar acknowledged no SQLite só após recibo aplicado/duplicado válido.
5. Ausência de recibo/resposta incerta mantém pendência para consulta/reenvio. Usar backoff exponencial com jitter e teto inicial proposto de cinco minutos, com tentativa ao restabelecer conexão.
6. Repetir com limites de CPU/conexão e prioridade ao atendimento. Token expirado não apaga fila nem transforma venda antiga em nova.
7. Download atualiza base confirmada sem apagar edição pendente; projeção de estoque incorpora movimentos locais ainda não recebidos.

## Conflito e resolução

Cadastro com base_version obsoleta preserva proposta e base; gerente escolhe aceitar servidor ou reapresentar alteração sobre versão atual. Não alterar snapshots da venda. Mudança de política de estoque não rejeita retroativamente venda anterior.

Sequência bloqueada exige processo explícito. Uma resolução administrativa autenticada pode registrar o destino da operação original e liberar a fronteira apenas quando as dependências forem reconciliadas; correção é nova operação com novo ID, vinculada à original, enviada por fluxo de resolução autorizado. Não depender de enfileirar simplesmente n+1 atrás de n bloqueada para resolver o bloqueio.

Definir transição/recibo de resolução no contrato antes de implementar: quais sequências foram consumidas, qual efeito foi aplicado e como dependentes passam a referenciar o fato válido. Cadastro abandonado pode ter resolução sem efeito financeiro; venda paga não recebe ação genérica “descartar”.

Quarentena por autorização ambígua/payload divergente conserva o original e não aparece como venda consolidada. Semântica de resolução financeira exige revisão identificada; jamais reescrever payload já tentado sob a mesma chave.

## Contratos

IPC: sync.getStatus, sync.requestRetry, sync.listConflicts e sync.submitResolution. Retentar é solicitação ao agendador, sem garantir envio imediato se bloqueado/sem conexão.

HTTP /api/v1: usar B10/B11 e acrescentar POST /admin/sync-resolutions, GET /admin/sync-resolutions/:id, com permissão específica, Idempotency-Key, versão esperada e auditoria. A rota não aceita SQL ou uma lista livre de operações para apagar.

Status inclui idade/quantidade conhecidas, último contato/recibo, operação impedida, compatibilidade e códigos seguros. Fila ilegível/terminal sem contato resulta em unknown/último estado recebido, nunca zero inventado.

## Critérios para FEITO

Desconectar antes/depois do commit remoto, reiniciar sending, repetir página, token expirar com fila antiga, editar produto web/offline e interromper resolução. Conferir venda, caixa e estoque por IDs/totais, não apenas contador da fila.

Cobrir piso de retenção, snapshot obrigatório preservando pendências, origem própria sem dupla baixa e sequência bloqueada sem perda. Registrar comandos, métricas e protocolo de resolução; **próxima:** B13. Base: [dados §§6–8](../../docs/banco-de-dados-e-sincronizacao.md).
