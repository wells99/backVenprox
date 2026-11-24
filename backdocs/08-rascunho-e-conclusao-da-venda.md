# B08 — Rascunho e conclusão atômica da venda

**Estado:** planejada. **Dependências:** B01–B07. [Sumário](00-SUMARIO.md). **Telas:** T01–T04. **Marco:** primeira venda durável local, ainda sem sincronização fim a fim.

## Objetivo e separação

Persistir rascunho e concluir venda com todos os efeitos locais numa única transação. Domínio calcula centavos, quantidades, desconto/rateio e troco; aplicação valida usuário/sessão/política e coordena a transação; infraestrutura grava; transporte não aceita totais/permissões da tela como autoridade.

Dados: sale_drafts e itens de rascunho; sales, sale_items, sale_payments; movimentos de B06/B07; auditoria, sequência e outbox. Venda concluída não volta a ser rascunho.

## Sequência da fatia

1. Persistir rascunho com sale_id estável e versão. Adicionar/editar/remover itens, cliente opcional, observação e desconto; recuperar após reinício sem considerar isso recebimento.
2. Calcular subtotal por preço em centavos × quantity_milli / 1.000, com arredondamento positivo metade para cima. Rateio por maior resto e desempate por ID estável do item; limites inteiros antes de multiplicar.
3. Preservar snapshots de descrição, unidade, preço autorizado, custo conhecido e valores finais por linha. Não consultar preço atual para reescrever venda concluída; preço proposto pelo terminal deve ter política/limites de autorização.
4. Receber intenção de conclusão, verificar resultado já existente e iniciar transação de escrita.
5. Na transação, revalidar autorização local, sessão aberta, versão do rascunho/política, itens e estoque agregado quando estrito. Guardar política efetiva/versão/autorização de origem.
6. Gravar venda, itens, pagamentos, baixas dos produtos cadastrados, movimentos por meio, auditoria e device_seq/outbox sale.completed. Avulso tem product_id nulo e custo desconhecido, sem baixa.
7. Commit e devolver resultado durável. Só então T04 pode mostrar venda feita; rede e impressão serão tarefas posteriores.
8. Resposta local perdida: repetir/consultar a mesma intenção e recuperar a venda original. Não gerar novo UUID porque o botão foi clicado outra vez.

## Pagamento e limites

Registro manual de Dinheiro/Crédito/Débito/Pix, enums técnicos B02. Soma applied_cents = total; tendered/change explícitos e consistentes. Só dinheiro produz troco; excesso digital e insuficiência são rejeitados. Não guardar PAN, CVV, PIN ou credenciais bancárias.

Permissivo aceita negativo/avulso sem modal; estrito exige cadastro ativo/saldo local suficiente. Total zero/gratuidade, descontos máximos e frações dependem do escopo aprovado; baseline do frontend usa total positivo e unidades inteiras. Capacidade de quantity_milli no contrato não autoriza vender fracionado sem decisão.

## Contratos

IPC: sales.createDraft, sales.getDraft, sales.updateDraft, sales.complete e sales.getCompletionResult. Atualização por versão; conclusão com sale_id/intention_id estáveis. Saída: venda e totais oficiais, local_commit_at e sync_status=pending; impressão não é condição de sucesso.

Não criar POST /sales/complete remoto para o Windows. /api/v1/sales será leitura consolidada B14; envio financeiro ocorre por /sync/push B10.

Preparar teste de contrato do evento completo contendo IDs e snapshots necessários para o servidor derivar os mesmos efeitos. Não enviar uma venda e também uma segunda lista autoritativa de baixas a aplicar em separado.

## Critérios para FEITO

Teste real: abrir caixa → vender sem rede → encerrar/reabrir serviço → recuperar venda e outbox. Cobrir troco/misto, rateio residual, limites, item avulso, linhas repetidas no estrito, ausência de sessão/permissão, duplo comando concorrente e resposta perdida.

Injetar falha entre cada gravação e antes/depois do commit: ou tudo existe, ou nada da conclusão existe. Disco cheio não produz sucesso. F2 desabilitado não substitui constraint/idempotência.

Registrar evidências/totais, migrations e como exercitar T02/T03 por adaptador local de teste; conexão completa das telas em B14. **Próxima:** B09. Base: [dados §§3/5](../../docs/banco-de-dados-e-sincronizacao.md).
