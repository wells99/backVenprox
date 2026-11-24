# B15 — Fiado manual persistido e sincronizado

**Estado:** planejada; complemento não crítico ao núcleo. **Dependências:** B01–B14. [Sumário](00-SUMARIO.md). **Telas:** T15–T18; integra Caixa/Relatórios.

## Objetivo e camadas

Registrar dívida/histórico do cliente e recebimento opcional no caixa. Domínio distingue aumento, correção, recebimento e reversão; aplicação coordena saldo/caixa/outbox; infraestrutura garante atomicidade/identidade. Não adicionar Fiado aos meios de pagamento da venda sem novo escopo.

Dados locais/remotos por migração: customers já existente, customer_debt_entries e debt_receipts, com IDs, autor, origem, centavos, instantes e vínculo de reversão/movimento quando houver. Saldo é soma auditável, não campo editável livre.

## Regra para vários caixas

O núcleo de vendas suporta vários terminais; saldo de dívida compartilhado offline não possui a mesma garantia. **Proposta segura inicial:** um terminal responsável por mutações de fiado na loja; os demais consultam estado recebido e não quitam offline.

Guardar/versionar essa responsabilidade. Transferência exige conexão, reconciliação das pendências do dono anterior e invalidação de sua autorização de escrita; se ele está perdido/desconectado, não ativar dois escritores por conveniência. Autorizar recebimentos concorrentes em qualquer caixa exige desenho próprio online/quotas e decisão registrada antes de remover essa restrição.

## Sequência

1. Migrar lançamentos/recibos em ambos os bancos; adicionar eventos, schemas, backup e snapshot operacional.
2. Aumentar dívida com motivo e permissão; diminuir por correção gera ajuste sem recebimento.
3. Receber/quitar calcula saldo ainda devido dentro da transação, bloqueando redução excessiva.
4. post_to_cash inicia falso como proposta de interface. Sem caixa: lançamento + recibo + outbox, sem exigir sessão.
5. Com caixa: exigir sessão aberta do terminal, meio e permissão; gravar também movimento único na mesma transação.
6. Reverter por lançamento vinculado, uma vez. Se houve caixa, devolver/reverter no meio/sessão permitidos; sessão encerrada não é reescrita.
7. Sincronizar cliente antes dos lançamentos; recebimentos não geram venda, faturamento ou estoque. Download/restauração não executa novo recebimento.

Exemplo de aceite: dívida 10000 centavos; receber 4000 → saldo 6000. Sem caixa, livro do caixa intacto. Com Pix, total digital +4000 e gaveta intacta; com dinheiro, gaveta +4000.

## Contratos

HTTP /api/v1: GET /customers/:id/debt-ledger com saldo e lançamentos paginados; GET /customers/:id/debt-receipts/:receipt_id. Apenas consulta autorizada no recorte web.

IPC: debt.getLedger, debt.increase, debt.correct, debt.receive, debt.settle e debt.reverse. Escritas exigem intenção estável, cliente, versão esperada do livro, motivo/tipo, autorização de escritor e dados de caixa quando escolhidos. Quitar tudo calcula na transação, sem confiar no saldo lido pela tela.

Erros: DEBT_EXCEEDS_BALANCE, DEBT_VERSION_CONFLICT, DEBT_WRITER_REQUIRED e CASH_SESSION_REQUIRED. Repetição deve devolver o resultado anterior; intenção antiga não quita novamente um saldo que cresceu depois.

## Critérios para FEITO

Testar aumento/ajuste, parcial/total com e sem caixa, meios digitais sem gaveta, saldo insuficiente, replay, duas tentativas concorrentes, permissão/escritor e reversão com sessão original fechada.

Obrigatório RF23/CA23: sincronizar, reconstruir em base separada e conferir cliente, histórico, saldo e movimento por ID sem recadastro ou novo recebimento. Testar falha no meio da transação e envio depois de reinício.

Registrar migrations, contratos, decisão de escritor e evidências. **Próxima:** B16, independente deste módulo. Referências: [backend §4.5](../../docs/backend.md), [dados §§4.2/4.5](../../docs/banco-de-dados-e-sincronizacao.md).
