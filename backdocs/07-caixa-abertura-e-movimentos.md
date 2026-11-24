# B07 — Caixa: abertura e movimentos

**Estado:** planejada. **Dependências:** B01–B06. [Sumário](00-SUMARIO.md). **Telas:** T06–T08; prepara venda B08 e fechamento B09.

## Objetivo e dados

Criar sessão de caixa por terminal, com valor inicial explicitamente informado, inclusive zero. Dados: cash_sessions, cash_movements e projeções de leitura. Domínio calcula totais por meio/tipo; aplicação autoriza abertura/movimento; repositório garante unicidade e commit.

Um estabelecimento com CX01/CX02/CX03 possui três sessões independentes. A hipótese é uma gaveta por sessão/terminal; compartilhar a mesma gaveta física entre três computadores exige desenho operacional adicional antes de liberar esse uso.

## Sequência

1. Migrar sessão/movimentos. Garantir no banco e serviço no máximo uma sessão aberta por device_id; escolher constraint compatível com cada motor, sem confiar só em SELECT prévio.
2. Abrir com intenção estável, operador autorizado, data comercial/fuso e opening_cents explícito. Omissão não vira zero automático.
3. Registrar abertura e outbox juntos; repetir intenção devolve a sessão existente, sem segunda entrada.
4. Suprimento e sangria exigem valor positivo, motivo e permissão. Converter para sinais/tipos internamente e impedir movimento em sessão fechada.
5. Consultar caixa atual/anteriores e livro por origem; preparar recebimentos/restituições de B08/B09 e fiado de B15.

## Fórmulas e invariantes

Dinheiro esperado = abertura + vendas aplicadas em dinheiro + fiado em dinheiro com post_to_cash + suprimentos − sangrias − restituições/reversões em dinheiro.

Pix/crédito/débito ficam em totais próprios; valor entregue em espécie não é o aplicado quando há troco. Fiado sem caixa, correção de dívida e lembrete não alteram a gaveta. Pagamento misto gera componentes identificados, sem movimento Misto de valor ambíguo.

Movimentos são imutáveis; correção é novo movimento vinculado/autorizado. Não alterar a contagem de sessão fechada ao estornar venda antiga. Saldo negativo por sangria depende da regra de P08: não inventar bloqueio silencioso, registrar a política aprovada antes de habilitar.

## Contratos e experiência

HTTP /api/v1: GET /cash-sessions, GET /cash-sessions/:id e GET /cash-sessions/:id/movements, com escopo do consolidado e atualização por terminal. Não permitir abertura/sangria online no primeiro recorte.

IPC: cash.getCurrent, cash.listSessions, cash.getSession, cash.open, cash.registerSupply e cash.registerWithdrawal. Retornar sessão, esperado por meio e pending_sync sem alegar recebimento remoto.

Requisições de escrita trazem intention_id e sessão esperada quando aplicável; operador/loja/dispositivo vêm do contexto autorizado. Erros estáveis: CASH_ALREADY_OPEN, CASH_SESSION_REQUIRED, CASH_SESSION_CLOSED, PERMISSION_DENIED. A UI restaura foco/contexto e abre T06 quando necessário.

Eventos cash.opened e cash.movement_recorded entram na outbox com device_seq; abertura precisa chegar antes das vendas da sessão. Nenhum caminho remoto alternativo de abertura é criado para contornar dependência.

## Critérios para FEITO

Testar abertura com zero, ausência/valor inválido, duas aberturas concorrentes, replay, reinício offline, sangria/suprimento sem permissão/motivo e rollback junto da outbox. Livro e esperado devem conferir por meio. Sessões dos três devices não colidem e não permitem gravar no caixa de outro terminal.

Registrar migrations, política de saldo, comandos/evidências e próxima B08. Base: [backend §4.2](../../docs/backend.md), [dados §9](../../docs/banco-de-dados-e-sincronizacao.md).
