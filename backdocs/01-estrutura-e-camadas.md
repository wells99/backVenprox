# B01 — Estrutura, camadas e provas técnicas

**Estado:** planejada. **Dependências:** revisão do [sumário](00-SUMARIO.md). **Conexão:** prepara B02–B04; não implementa módulos antecipadamente.

## Objetivo e decisões

Criar uma base modular que rode como API remota, serviço local e processo de jobs, sem repetir regras. Manter front-Venprox intacto nesta etapa; não mover todo o repositório só para adotar um monorepositório. TypeScript/Fastify seguem a recomendação existente; registrar a escolha efetiva de runtime/driver e sua justificativa antes de fixar versões.

Estrutura **proposta para implementação futura**, relativa a back-Venprox:

~~~text
backdocs/                    estes 20 guias
apps/
  api/                       composição HTTP remota
  local-service/             composição do serviço SQLite e entrada IPC
  worker/                    composição dos executores de jobs
packages/
  domain/                    módulos: sales, cash, stock, customers...
  application/               casos de uso, portas e contexto autorizado
  contracts/                 schemas/DTOs HTTP, IPC, operações e recibos
  infrastructure/
    sqlite/                  repositórios locais e unidade transacional
    mysql/                   repositórios remotos e unidade transacional
    jobs/                    reserva/retentativa de trabalho
    native/                  ponte para segredos/impressão, quando necessária
migrations/
  sqlite/
  mysql/
tests/                       contratos, integração, falhas e carga
~~~

Não criar pacotes vazios sem consumidor. O invólucro Electron terá composição/preload próprios ao integrar o Windows; não expor Node ao renderer nem forçar o serviço local a ser um servidor HTTP público.

## Passo a passo por responsabilidade

1. Definir scripts de build, análise estática, testes e configuração tipada; validar variáveis obrigatórias no boot e falhar com mensagem segura.
2. Aplicar limites de importação: domínio não importa aplicação/infra; aplicação não importa drivers; adaptadores não chamam repositório pulando o caso de uso.
3. Criar composição separada por processo e portas pequenas para Clock, IdGenerator, UnitOfWork, Audit e repositórios. Injetar dependências no ponto de entrada, sem service locator global.
4. API modular por área, sem microsserviços. Handlers traduzem transporte e chamam aplicação; aplicação coordena; domínio calcula; adaptador executa SQL parametrizado.
5. Logs estruturados com request_id, operation_id, device_id e duração; redigir segredos desde o primeiro logger.
6. Provar runtime/driver local no processo dedicado e seu caminho de empacotamento Windows. Provar uma transação remota no motor efetivo do plano antes de construir sobre suposições.

## Contratos e saídas verificáveis

Reservar GET /health para liveness mínimo e GET /api/v1/compatibility para versões de app/protocolo aceitas. Readiness interna pode verificar banco sem expor detalhes publicamente; liveness não é diagnóstico de fila vazia.

As três composições usam configuração própria e desligamento controlado. A API não começa workers implicitamente em cada réplica. O serviço local possui um dono para escrita; o worker remoto não abre o SQLite de um caixa.

## Provas e limites

- Escolher Node mantido e plugins compatíveis; o Node embarcado no Electron pode diferir do servidor. Validar ABI do driver no aplicativo empacotado.
- Confirmar engine/versão MySQL ou compatível, transações e recursos do plano. Não declarar suporte a worker permanente sem essa prova.
- Para desenvolvimento, usar recursos locais/isolados; implantação externa e credenciais reais só em etapa autorizada.
- Sem rede, o serviço local inicia e responde ao diagnóstico. Nenhum erro de conexão gera outro banco vazio.

## Critérios para FEITO

Build/lint e verificação de fronteiras aprovados; uma execução de cada composição documentada; configuração inválida e desligamento testados. Provas de persistência podem ser concluídas em B03, mas incompatibilidade de runtime/plano deve estar registrada como bloqueio da dependência afetada, sem sucesso fictício.

**Registro ao concluir:** versões, estrutura realmente criada, comandos, evidências e pendências; próxima B02. Referências: [backend §§1–3](../../docs/backend.md), [Windows](../../docs/windows.md).
