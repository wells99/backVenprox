# B10 — Recepção remota idempotente

**Estado:** planejada. **Dependências:** B01–B09. [Sumário](00-SUMARIO.md). **Conexão:** recebe os fatos locais; prepara log/cursor B11 e sincronizador B12.

## Objetivo e camadas

Transportar pelo menos uma vez e produzir efeito único por IDs/constraints/transação. Adaptador HTTP autentica terminal e valida envelope; aplicação seleciona handler por tipo/versão; domínio confere invariantes históricas; MySQL mantém inbox e efeitos no mesmo commit.

Receber venda ocorrida não é refazê-la com estoque/preço/permissões atuais. Validar origem autorizada e snapshots efetivos; divergência legítima de preço/política não deve apagar uma venda paga. Payload inválido/adulterado exige quarentena/revisão, sem efeito financeiro silencioso.

## Envelope e tabelas

Envelope: protocol_version, payload_version, store_id, device_id, operation_id, device_seq, type, occurred_at_device, origin_authorization, dependencies, payload e payload_hash. Sequência/cursores grandes em strings decimais. Serialização canônica versionada, especificada com vetores de teste em B02; hash não é assinatura nem autenticação.

Migrar server_inbox e fronteira de recebimento por terminal. Unique em operação e device_seq dentro da origem; hashes/recibos duráveis. Constraints adicionais da venda/origem também impedem dois operation_ids produzirem a mesma conclusão.

## Passo a passo transacional

1. Autenticar credencial restrita, conferir loja/dispositivo e limitar envelope/lote.
2. Verificar hash sobre representação canônica acordada, sem normalizar novamente o conteúdo recebido. Conferir protocolo/tipo suportados.
3. Serializar recepção por device_id no banco e validar a próxima sequência contígua. Abertura precede venda, venda precede reversão.
4. Reservar chave única na inbox na mesma transação do efeito; não usar apenas SELECT seguido de INSERT sem constraint.
5. Se já existe mesmo ID/hash, retornar recibo original após commit visível. Mesmo ID com conteúdo diferente ou mesma sequência com outra operação é conflito/incidente.
6. Validar dependências/autorização de origem e persistir agregado/movimentos/auditoria derivados uma vez. Não reaplicar também movimentos independentes duplicando o agregado.
7. Publicar mudanças pelo mecanismo B11, registrar recibo final e avançar fronteira apenas conforme resultado permitido; commit antes de responder.

B10 implementa inbox/handlers e testa atomicidade no banco. O contrato de publicação transacional nasce aqui e fica plenamente implementado/testado em B11; **não liberar sync operacional antes de B11**, para que não existam fatos aceitos sem log.

## Rotas sob /api/v1

| Rota | Entrada e saída |
| --- | --- |
| POST /sync/push | Credencial terminal; lote ordenado; data.items com recibo por operação |
| GET /sync/receipts/:operation_id | Resultado durável autorizado, sem executar efeito novamente |
| GET /sync/device-state | Fronteira recebida, compatibilidade e identidade do próprio terminal |

Recibos distinguem applied, duplicate, conflict, blocked e quarantined, com operation_id, device_seq, hash, resultado e motivo seguro. duplicate significa mesmo resultado anteriormente confirmado. HTTP 200 não aceita os itens sem recibo. 202 de job não é recibo de venda consolidada.

Propostas iniciais: até 50 operações e 512 KiB por lote, limitando também item individual. Cada operação é uma transação; parar cadeia dependente no primeiro impedimento e informar itens não processados. Reavaliar limites por medição.

## Erros e conservação

Operação com estado permanente não desaparece nem tem payload alterado sob o mesmo ID. Correção usa nova identidade e resolução auditada da dependência/fronteira em B12. Não avançar sequência pulando fatos financeiros.

Manter identidade/hash/recibo pelo horizonte de restauração e histórico necessário; expirar tudo em poucos dias permitiria duplicação ao restaurar backup antigo. Rejeições/quarentena são preservadas, separadas de vendas consolidadas.

## Critérios para FEITO

Testar 100 reenvios, requisições paralelas idênticas, ID/hash divergentes, sequência colidente/faltante, loja errada, protocolo antigo, dependência ausente e limite de lote. Descartar resposta após commit e repetir: uma venda, um conjunto de movimentos, mesmo recibo.

Matar processo em pontos da transação: inbox não pode confirmar efeito ausente, nem existir efeito confirmado sem recibo. Testar no motor real. Registrar evidências e próxima B11. Base: [dados §6](../../docs/banco-de-dados-e-sincronizacao.md).
