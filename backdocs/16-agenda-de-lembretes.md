# B16 — Contas a pagar como agenda de lembretes

**Estado:** planejada; complemento não crítico. **Dependências:** B01–B14; não depende de B15. [Sumário](00-SUMARIO.md). **Telas:** T19/T20 e toast transversal.

## Objetivo e responsabilidade

Persistir descrição, valor informativo, vencimento/data-hora/fuso e recorrência opcional. Não cria conta contábil, baixa de caixa, compra ou despesa automática. Domínio calcula calendário/estado; aplicação gera/resolve/adía; infraestrutura persiste e agenda; frontend exibe toast sem roubar foco.

Dados de negócio **SQLite e remoto:** bill_reminders e reminder_occurrences. notification_deliveries por terminal pode ser local. Resolver conta não é apenas fechar toast; ignorar toast não marca ocorrência resolvida.

## Sequência

1. Migrar regra/ocorrências e índice de vencimento/estado; incluir em sync, snapshot operacional e backup desde a entrega.
2. Criar/editar/desativar série por versão; preservar resolvidas e histórico anterior.
3. Gerar ocorrências com identidade estável e unique de regra + vencimento. Não gerar UUID diferente para mesma ocorrência em cada reinício.
4. Calendário proposto: única, diária, semanal, mensal/anual com intervalo. Dia 29–31 ajusta ao último dia de mês curto, conservando dia-âncora para os próximos meses.
5. Armazenar zona IANA, horário local pretendido e instante UTC resolvido; definir tratamento de horário inexistente/ambíguo antes de ativar recorrência em zonas com mudança de relógio. Versão da regra identifica a origem.
6. Adiar/resolver ocorrência específica em transação com outbox, sem alterar caixa. Gerar futuras em horizonte limitado, não uma série infinita.
7. Consultar vencimentos ao abrir/retomar e periodicamente com app ativo. Deduplicar entregas; agrupar atrasados, sem rajada.

## Responsabilidade com vários terminais

Proposta: um terminal responsável por editar/gerar agenda, com identidade/configuração versionadas, enquanto os demais consultam. Evita geração offline independente ou edição concorrente ainda não especificada. Preferência de quais terminais exibem avisos é separada e pode ser por device.

Unique remoto não elimina dois toasts já exibidos offline. Deduplicação por ocorrência/terminal significa no máximo um aviso por terminal segundo a política, sem promessa de um único aviso físico global com todos desconectados. Transferência do responsável segue reconciliação, não dois donos simultâneos.

Processo encerrado/computador desligado não entrega toast no horário; recuperar ao reabrir. Serviço Windows/bandeja/notificação nativa é extensão de P14, sem obrigar worker remoto permanente para uma agenda local.

## Contratos

HTTP /api/v1: GET /bill-reminders; GET /bill-reminders/:id; GET /bill-reminders/:id/occurrences. Escrita web ainda fora do recorte inicial.

IPC: reminders.list, reminders.create, reminders.update, reminders.snoozeOccurrence, reminders.resolveOccurrence, reminders.disableSeries e reminders.getDueNotifications. Reconhecimento de entrega separado: reminders.ackNotification, sem efeito de negócio/caixa.

Entradas seguem B02, com versão/intenção quando mutáveis. Erros de calendário e conflito têm path/código; saída preserva fuso, âncora e estado de cada ocorrência.

## Critérios para FEITO

Reinício antes/depois do toast, mês curto seguido de mês longo, ano bissexto, relógio/fuso, adiamento/resolução e desativação da série. Reenvio/reexecução não duplica ocorrência. Nenhum teste altera faturamento, caixa ou fiado.

RF23/CA23: reconstruir regras e ocorrências já recebidas, incluindo resolvidas/adiadas; não reabrir pendência resolvida nem perder histórico. Conferir responsável e preferência de aviso em três terminais.

Registrar frequências efetivamente aprovadas, migrations, testes e próxima B17/B18. Referências: [backend §4.6](../../docs/backend.md), [dados §§4.3/4.5](../../docs/banco-de-dados-e-sincronizacao.md).
