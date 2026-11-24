# B06 — Estoque por movimentos

**Estado:** planejada. **Dependências:** B01–B05. [Sumário](00-SUMARIO.md). **Telas:** T13/T14; regras reutilizadas por T02/T05.

## Objetivo e responsabilidade

Criar livro de movimentos identificados e projeções reconstruíveis, sem permitir edição livre de saldo no cadastro. Domínio define quantidade, sinal e invariantes; aplicação autoriza entrada/ajuste; infraestrutura grava movimento e projeção na mesma transação.

Dados: stock_movements, stock_balances e referências/origens. Todo movimento possui ID estável, produto, quantidade assinada, motivo quando manual, operador, device_id e instante. Unique por origem/tipo/item evita baixa ou estorno duplicados.

## Passo a passo

1. Migrar movimentos/projeções e índices por produto/data/ID; saldo inicial/importado também nasce como movimento de abertura.
2. Implementar entrada com quantidade positiva e custo explicitamente conhecido/desconhecido; validar unidade e faixas.
3. Implementar ajuste absoluto com saldo-base/versão esperada: calcular delta na transação. Se a base mudou, retornar conflito em vez de sobrescrever uma venda ocorrida entre leitura e confirmação.
4. Criar operação interna para baixa/restauração por origem, usada por B08/B09; não expor esse helper como endpoint público arbitrário.
5. Validar projeção pela soma do livro e permitir reconstrução administrativa controlada, sem criar movimentos extras.

## Políticas e vários caixas

**Permissive é o padrão:** produto cadastrado pode ficar negativo, sem aviso repetitivo. Avulso não inventa produto nem baixa. **Require_stock:** agrega todas as linhas do mesmo produto e valida saldo local dentro da transação de venda, impedindo avulso e insuficiência.

Cada terminal tem uma visão que pode estar atrasada. Três caixas offline podem vender a última unidade observada: mais workers no servidor não elimina esse limite. Proposta inicial: modo estrito garante apenas a abrangência local e deve explicitar isso ao administrador.

Se o negócio exigir **garantia global sem negativo**, escolher antes de ativar: coordenação online/reservas centrais ou quotas por terminal com regras de devolução/rebalanceamento. Não implementar essa promessa só somando saldos remotos. Tal escolha pode exigir revisão da continuidade offline para esse modo; permanece pendente.

Ajuste absoluto sobre visão local com vários terminais não representa inventário global. Registrar escopo e base; inventário global exige janela sem movimentos ou procedimento coordenado. Entrada/saída comuns continuam deltas identificados.

## Contratos

HTTP /api/v1: GET /stock/balances e GET /stock/movements com produto, período, ordenação/paginação estável e scope/as_of. Escrita remota de estoque fica fora do recorte web; nenhuma rota POST /stock/set-balance.

IPC: stock.getBalances, stock.getMovements, stock.registerEntry, stock.adjustCount. Escritas exigem permissão, motivo, intention_id, versão/base do ajuste e outbox atômica; retornam movimento, saldo resultante e abrangência local.

Evento de sync inclui delta/origem e IDs, não apenas saldo. Recepção remota não revalida venda antiga contra o saldo/preço atuais. Download reconhece movimento próprio e não baixa novamente.

## Custos e testes

Custo desconhecido não é zero. Método de custeio em P10 continua a definir; até aprovação, preservar snapshots conhecidos/estimativa e cobertura. Não implementar média ponderada parcial como custo confiável de todo o saldo.

**Critérios para FEITO:** entrada/ajuste com rollback, ajuste concorrente com venda, linha repetida no estrito, negativo silencioso no permissivo, avulso sem movimento, replay por origem e reconstrução igual à projeção. Validar quantidade_milli e unidade inteira, sem ponto flutuante. Ensaio com três terminais é ampliado em B13.

Registrar migrations, regras de custo/escopo, testes e próxima B07. Referências: [dados §§3/4/9](../../docs/banco-de-dados-e-sincronizacao.md), [decisões P01/P09/P10](../../docs/decisoes-e-pendencias.md).
