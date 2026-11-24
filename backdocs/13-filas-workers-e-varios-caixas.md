# B13 — Filas, workers e operação com vários caixas

**Estado:** planejada. **Dependências:** B01–B12. [Sumário](00-SUMARIO.md). **Origem:** preparação explícita solicitada em 24/11/2026 para três caixas e mais de um worker.

## Objetivo: o que escalar e por quê

| Componente | Estratégia | Garantia/limite |
| --- | --- | --- |
| Serviço local | Um dono da escrita por SQLite; processo dedicado ao atendimento | Workers de CPU não viram escritores livres da mesma base |
| Sync do terminal | Ordem/uma cadeia por device_id; devices diferentes enviam em paralelo | Não paralelizar operações dependentes do mesmo caixa |
| API remota | Instâncias sem estado financeiro em memória; unicidade e locks no banco | Sessões, idempotência e limites globais precisam armazenamento compartilhado |
| Jobs remotos | Um ou mais processos reservando trabalho durável | Reserva exclusiva temporária, reexecução idempotente |

Três vendas simultâneas não exigem por si só Redis ou microsserviços. O servidor já aceita requisições concorrentes; o requisito principal é integridade. A barreira de publicação B11 serializa um trecho curto por loja, e adicionar workers não remove esse ponto.

## Escolha proposta para fila

Preservar **outbox financeira local** como fonte de reenvio e **inbox remota** como recibo transacional. Não trocar essas estruturas por jobs em memória.

Para tarefas demoradas/independentes (materialização grande, exportação, manutenção), propor fila SQL durável por uma porta JobQueue, com executor iniciado separadamente. Isso reutiliza o banco e permite vários workers sem exigir Redis inicialmente. Implementar apenas se o motor/plano provar reserva concorrente e execução; se a escala exigir broker, trocar o adaptador sob a mesma porta após medir.

Não há fila assíncrona obrigatória entre /sync/push e o commit financeiro. A resposta aplicada de B10 continua aguardando commit; trabalho aceito numa fila não é venda consolidada. Snapshot/exportação podem retornar 202 + job_id persistido.

## Reserva, lease e falhas

1. Migrar jobs com id, tipo/versão, payload seguro, deduplication_key, partition_key, status, available_at, attempts, lease_owner, lease_until e lease_token/geração.
2. Inserir intenção de job junto do commit que exige esse trabalho, ou usar outbox de despacho transacional; não deixar intervalo “negócio salvo, job esquecido”.
3. Reservar lote pequeno atomicamente numa transação curta. MySQL compatível pode usar FOR UPDATE SKIP LOCKED para a tabela de jobs; validar versão/isolamento. Não usar SKIP LOCKED para omitir validação financeira geral.
4. Após reservar, executar fora da transação de reserva, com timeout, heartbeat e lease. Após queda, lease expirada permite outra tentativa.
5. ACK/renovação exigem owner e token de reserva atuais; worker antigo não pode encerrar a tarefa reatribuída. Efeitos no banco exigem também unicidade/idempotência na mesma transação.
6. Para efeitos externos, usar chave idempotente do provedor ou reconciliar resultado incerto. Lease/fencing não garantem uma única impressão física/upload externo.
7. Retentar transitórios com jitter/teto; permanentes vão a failed_review, preservando motivo e payload protegido. Nova tentativa manual é auditada, não exclusão/recriação cega.
8. Limitar concorrência por tipo e partição; quando a ordem for necessária, uma tarefa ativa por chave. Dar prioridade à fila financeira e separar mídia/exportação.

## Operação e contratos

Executores reutilizam casos de uso/portas; job handler não contém regra de venda. Implantação pode usar processo permanente em ambiente que permita ou invocação agendada limitada, com a mesma reserva. Não habilitar ambos sem coordenação nem iniciar um loop em cada API.

HTTP /api/v1: GET /jobs/:id limitado ao solicitante/loja e POST /admin/jobs/:id/retry com permissão, idempotência e motivo. Sem endpoint que aceite nome de função/código arbitrário.

Pools/conexões devem considerar API + todos os workers, em vez de cinco por processo sem somar. Medir fila, idade, vazão, duração, leases expiradas, conflitos/deadlocks, CPU/IO e p95 local. Aumentar workers somente enquanto melhorar drenagem sem degradar venda/banco.

## Ensaio obrigatório de três terminais

- CX01/CX02/CX03: três SQLite independentes, credenciais e sessões próprias, mesmo store_id; UUIDs/números legíveis sem colisão.
- Vender simultaneamente online e offline; reconectar em ordens distintas. IDs, caixa por sessão, estoque consolidado e recibos devem convergir uma vez.
- Matar worker após efeito antes do ACK, expirar lease durante execução e retomar com dois workers; token antigo não confirma nem duplica efeito.
- Enviar operação idêntica por duas instâncias da API e testar publicação concorrente B11. Um terminal bloqueado não deve parar os outros.
- Drenar 10.000 operações distribuídas com interrupções, registrando massa/hardware/tempo. Sem promessa prévia de vazão.
- Demonstrar limite do estoque estrito local; garantia global só após política específica. Fiado permanece escritor responsável B15, sem promessa de saldo global offline.

**Critérios para FEITO:** reserva concorrente, falhas, limites e testes acima aprovados no motor real; procedimento para um/dois workers documentado e compatível com a hospedagem. Evidência de concorrência não pode ser apenas Promise.all com banco mockado. Próxima B14.

Fundamentos consultados em 24/11/2026: [MySQL locking reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html), [Hostinger limites](https://www.hostinger.com/support/hostinger-node-js-limits-for-web-and-cloud-plans/). A escolha de fila SQL é proposta do projeto, condicionada a essas provas.
