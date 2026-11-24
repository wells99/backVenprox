# B09 — Reversões e fechamento de caixa

**Estado:** planejada. **Dependências:** B01–B08. [Sumário](00-SUMARIO.md). **Telas:** T05/T07/T09. Duas subentregas sequenciais; concluir ambas antes de marcar a parte.

## Objetivo e dados

Permitir cancelamento total/restituição e encerrar sessão sem apagar fatos. Domínio limita quantidades/valores reversíveis; aplicação exige permissão/motivo e sessão adequada; infraestrutura grava reversão, movimentos e outbox atomicamente.

Migrar sale_reversals, refund_payments e controle dos valores/quantidades por item; fechamento acrescenta esperado, contado, diferenças, motivo, autor e fronteira device_seq da sessão. Devolução parcial tem desenho compatível, mas ativação depende de P06 e não é automaticamente incluída.

## A. Cancelar e restituir

1. Consultar venda original e reversões dentro da transação; verificar intenção, estado e permissão.
2. Cancelamento total único, com motivo. Não editar preço/data/pagamentos da venda original.
3. Restaurar somente quantidades que efetivamente geraram baixa; avulso não cria produto/estoque.
4. Restituir pelos meios/valores definidos no comando autorizado, com limite do ainda restituível. Sem integração bancária, trata-se de informação manual, sem alegar estorno autorizado pelo banco.
5. Se a sessão original fechou, usar uma sessão atual aberta/autorizada para a saída; preservar o fechamento antigo. A restituição posterior entre terminais precisa respeitar dono da sessão/permissão, sem gravar em SQLite de outro caixa.
6. Gravar reversão, devoluções, movimentos, auditoria e sale.reversed na mesma transação; repetir intenção recupera o resultado.

Sem sessão atual necessária, bloquear a restituição e explicar; não marcar como estornado só para esconder uma dívida operacional. Se houver necessidade de cancelar sem devolver imediatamente, isso exige estado/caso de uso separado, não comportamento implícito.

## B. Fechar e reconciliar

1. Ler prévia do esperado por meio e versão/fronteira; operador informa contagens.
2. Validar que nenhuma venda/movimento ocorreu após a prévia; se ocorreu, devolver conflito e atualizar conferência.
3. Na transação, congelar esperado, contado/diferença, motivo quando exigido, operador e última sequência da sessão. Impedir nova escrita na sessão fechada.
4. Gerar cash.closed na outbox e retornar fechamento **local**; pode acontecer sem rede.
5. Servidor só marcará reconciliado após receber todas as operações da fronteira e conferir totais B10/B12. Recebido, fechado localmente e reconciliado são estados distintos.

## Contratos

IPC: sales.reverse, cash.previewClose, cash.close e cash.getClosure. Entrada com intenção estável, motivo, referências e versão/fronteira esperadas. Erros: ALREADY_REVERSED, REFUND_EXCEEDS_REMAINING, CASH_SESSION_REQUIRED, CLOSURE_STALE e PERMISSION_DENIED.

HTTP /api/v1: consultas de detalhe/reversões/fechamentos por B14; nenhuma mutação financeira web por conveniência. Eventos preservam dependência abertura → venda → reversão → fechamento conforme a sessão envolvida.

## Critérios para FEITO

Cancelamento reenviado/concorrente produz uma restauração e uma restituição; testar avulso, misto, falta de permissão/motivo, limite já devolvido e sessão original fechada. Interrupção mantém atomicidade.

Fechar offline com zero/valores diversos, movimento concorrente após prévia e duas tentativas simultâneas. Documento encerrado não muda após estorno posterior; próximo caixa abre com nova identidade.

Registrar contratos, migrations, testes e partes adiadas (ex.: parcial). **Próxima:** B10. Base: [backend §§4.2/4.4](../../docs/backend.md), [dados §9](../../docs/banco-de-dados-e-sincronizacao.md).
