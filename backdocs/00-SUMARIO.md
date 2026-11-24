# Venprox — roteiro de construção do backend

**Data:** 24/11/2026. **Estado:** planejamento para revisão; nenhuma etapa implementada.

**Total: 20 arquivos Markdown nesta pasta — este sumário e 19 partes de implementação.** Cada parte informa objetivo, dependências, responsabilidades por camada, contratos, dados, sequência e critérios de conclusão. Trabalhar em uma parte por vez; não gerar o backend inteiro a partir deste índice.

## O que estamos preparando

O backend compreende **serviço local do Windows e API remota**, com domínio e casos de uso compartilhados. A venda sempre confirma primeiro no SQLite do terminal, mesmo com internet; depois sincroniza por HTTPS. A API consolida em banco próprio da loja e atende o acesso web. Um estabelecimento poderá ter vários terminais, cada qual com identidade, SQLite e caixa próprios.

A orientação de 24/11 acrescenta preparação para três caixas simultâneos, mais de um worker, camadas explícitas e documentação das rotas. Isso substitui o antigo recorte técnico de um único terminal como limite de arquitetura. Ainda faltam as regras de estoque estrito global, fiado concorrente e eventual gaveta compartilhada; três caixas não significam três escritores sobre um arquivo SQLite.

**Frontend encontrado:** T00–T24 implementadas em simulação, conforme [roteiro atual](../../front-Venprox/PLANO-DE-TELAS.md). Os guias gerais ainda contêm registros históricos até T07; prevalece o roteiro atual para o estado visual. Telas prontas não comprovam autenticação, banco, impressão ou sincronização reais.

## Sumário e ordem

| Parte | O que entrega quando implementada | Dependências | Estado |
| --- | --- | --- | --- |
| [01 — Estrutura e camadas](01-estrutura-e-camadas.md) | Organização do código, fronteiras e provas de runtime/hospedagem | Revisão deste plano | Planejada |
| [02 — Contratos, validação e OpenAPI](02-contratos-validacao-e-openapi.md) | Entradas/saídas comuns, normalização, erros e Swagger por rota | 01 | Planejada |
| [03 — Persistência e migrações](03-persistencia-e-migracoes.md) | SQLite/MySQL, unidade transacional, constraints e evolução segura | 01–02 | Planejada |
| [04 — Identidade e acesso](04-identidade-autenticacao-e-permissoes.md) | Setup, usuários, permissões, pareamento e autorização offline | 01–03 | Planejada |
| [05 — Cadastros e configurações](05-cadastros-e-configuracoes.md) | Produtos, categorias, clientes mínimos e preferências versionadas | 01–04 | Planejada |
| [06 — Estoque por movimentos](06-estoque-e-movimentos.md) | Entradas, ajustes, projeções e regras permissiva/estrita | 01–05 | Planejada |
| [07 — Caixa e movimentos](07-caixa-abertura-e-movimentos.md) | Abertura, sessão por terminal, suprimento, sangria e leitura | 01–06 | Planejada |
| [08 — Rascunho e conclusão da venda](08-rascunho-e-conclusao-da-venda.md) | Venda local atômica com itens, pagamentos, estoque, caixa e outbox | 01–07 | Planejada |
| [09 — Reversões e fechamento](09-reversoes-e-fechamento.md) | Cancelamento/restituição e conferência imutável do caixa | 01–08 | Planejada |
| [10 — Recepção remota idempotente](10-recepcao-remota-e-idempotencia.md) | Inbox, recibos e consolidação transacional sem duplicação | 01–09 | Planejada |
| [11 — Alterações e snapshots](11-alteracoes-e-snapshots.md) | Download com cursor seguro e capturas consistentes | 01–10 | Planejada |
| [12 — Sincronizador e conflitos](12-sincronizador-e-conflitos.md) | Envio/retomada local, download e resolução auditada | 01–11 | Planejada |
| [13 — Filas, workers e vários caixas](13-filas-workers-e-varios-caixas.md) | Jobs duráveis, execução concorrente e ensaios com três terminais | 01–12 | Planejada |
| [14 — Consultas e integração das telas](14-consultas-relatorios-e-frontend.md) | Histórico, relatórios, diagnóstico e troca dos adaptadores fictícios | 01–13 | Planejada |
| [15 — Fiado manual](15-fiado-manual.md) | Histórico de dívida, recebimento com/sem caixa e recuperação | 01–14 | Planejada; complemento |
| [16 — Agenda de lembretes](16-agenda-de-lembretes.md) | Contas a pagar persistidas, recorrência e avisos sem efeito financeiro | 01–14; independe de 15 | Planejada; complemento |
| [17 — Comprovantes e extensões](17-comprovantes-e-extensoes.md) | Impressão não fiscal; contratos fiscal/mídia com implementação separável | 01–14; independe de 15–16 | Planejada; complemento/extra |
| [18 — Backup, recuperação e importação](18-backup-recuperacao-e-importacao.md) | Recuperação completa, preservação de fila e migração do legado | 01–14; incluir módulos efetivamente entregues | Planejada |
| [19 — Homologação e operação](19-homologacao-implantacao-e-operacao.md) | Evidências de integridade/carga, instalação por loja e liberação | Núcleo 01–14, 18 e complementos escolhidos | Planejada |

A numeração é uma sequência de trabalho, não obrigação de entregar todos os extras antes do piloto. Partes 15/16 são independentes entre si; 17 separa impressão, porta fiscal e fotos. A conveniência do assistente T24 continua separada da recuperação básica obrigatória. Backups mínimos e testes começam nas partes 03/04; a parte 18 ensaia o conjunto completo, não adia proteção de dados até o final.

## Como se conectam

~~~mermaid
flowchart TD
    A[01 Estrutura] --> B[02 Contratos]
    B --> C[03 Persistência]
    C --> D[04 Identidade]
    D --> E[05 Cadastros]
    E --> F[06 Estoque]
    F --> G[07 Caixa]
    G --> H[08 Venda local]
    H --> I[09 Reversão e fechamento]
    I --> J[10 Inbox remota]
    J --> K[11 Cursor e snapshots]
    K --> L[12 Sincronizador]
    L --> M[13 Filas e vários caixas]
    M --> N[14 Consultas e frontend]
    N --> O[15 Fiado]
    N --> P[16 Lembretes]
    N --> Q[17 Comprovantes e extensões]
    N --> R[18 Recuperação completa]
    O -. incluir se entregue .-> R
    P -. incluir se entregue .-> R
    Q -. incluir se entregue .-> R
    R --> S[19 Homologação e operação]
~~~

## Arquitetura proposta e motivo

**Monólito modular em TypeScript**, com Fastify na API, SQLite local e MySQL/InnoDB remoto, sujeito à prova do plano/engine. É a recomendação dos guias existentes; camadas são uma preferência explícita do responsável. Não implica microsserviços, nova linguagem ou um backend por caixa.

| Camada | Responsabilidade | Dependências permitidas |
| --- | --- | --- |
| Domínio | Dinheiro, quantidades, invariantes e transições puras | Nenhum framework, SQL, React ou Electron |
| Aplicação | Casos de uso, autorização de negócio, transações por portas | Domínio e portas; sem driver concreto |
| Contratos | Schemas de entrada/saída e versões HTTP/IPC/sync | Bibliotecas de contrato; sem serviço/banco |
| Adaptadores de entrada | HTTP, IPC e despacho de jobs | Contratos e aplicação |
| Infraestrutura | SQLite/MySQL, fila, relógio, segredos, impressão | Implementa portas; regras financeiras permanecem no domínio/aplicação |
| Composição | Monta API, serviço local e worker com dependências reais | Conhece implementações; nenhuma regra de venda |

Interfaces de repositório são específicas por necessidade; evitar um CRUD genérico que esconda bloqueios e transações. O mesmo caso de uso pode ter adaptadores diferentes, mas receber venda histórica na nuvem **não** é executar uma nova venda sob preços, permissões e estoque atuais.

## Regras que nenhuma parte pode inverter

- Venda, movimentos, sequência e outbox na mesma transação local; sucesso somente depois do commit. Rede e impressão fora dela.
- UUID estável para entidade/operação; número legível composto por código do caixa + sequência. Reenvio mantém ID e conteúdo.
- Sessão própria por terminal; nunca compartilhar SQLite por rede. O servidor soma o recebido, sem alegar que conhece o ainda offline.
- Estoque permissivo e avulso por padrão, sem alertas repetitivos; modo estrito precisa de política explícita de abrangência para vários caixas.
- Pagamentos são registros manuais; não guardar dados de cartão nem apresentar aprovação bancária.
- Fiado é independente da venda, caixa opcional; lembrete nunca gera despesa/saída. Ambos têm tabelas locais/remotas quando entregues.
- Impressão automática e Drive desligados. Porta fiscal não é emissão pronta. Nenhum segredo no React ou Swagger.
- Sincronização não substitui backup. Recuperação remota contém somente o que o servidor recebeu; pendência desconhecida não é zero.

## Protocolo de trabalho e marcação

1. Ler este sumário, a parte escolhida e suas referências. Implementar apenas o escopo solicitado; decisões propostas não viram aprovadas por silêncio.
2. Conferir as dependências realmente implementadas, versões, migrations e contratos. Concluir uma fatia verificável em banco real; não apenas classes vazias.
3. Manter a OpenAPI junto das rotas desde a parte 02; acrescentar autenticação, exemplos e erros a cada endpoint entregue. IPC possui catálogo próprio, sem fingir que é HTTP.
4. Executar os testes descritos na parte, registrar comandos/resultados, limitações, migrações e como conferir pelo frontend ou ferramenta de contrato.
5. Só então inserir na **primeira linha** do arquivo da parte: **FEITO - DD/MM/AAAA**, usando a data real de conclusão, e atualizar a tabela deste sumário.
6. Se houver pendências no escopo autorizado, manter **Em andamento** e apontá-las. Recortes explicitamente fora do escopo/adiados não bloqueiam o núcleo, mas sua situação deve acompanhar a marcação; nunca receber FEITO como se o extra existisse. B17 detalha essa distinção. Não marcar nenhuma parte FEITO apenas por escrever este guia.
7. Ao encerrar trabalho, registrar no próprio arquivo: entregue, evidência, falta fazer e próxima parte. Isso permite continuidade por outra IA sem novos arquivos obrigatórios.

## Decisões para revisar antes das partes dependentes

| Tema | Base de trabalho recomendada | Quando precisa de resposta/prova |
| --- | --- | --- |
| Stack/driver/hospedagem (P03/P05) | TS/Fastify, SQLite corrigido e MySQL; sem ORM universal obrigatório | 01/03; nenhuma contratação nesta documentação |
| Três caixas (P01/D09 revisada) | Três terminais distintos, sessões/gavetas próprias, mesmo estabelecimento | Base prevista agora; gaveta compartilhada exige novo desenho |
| Estoque estrito compartilhado | Permissivo suporta offline; estrito global requer coordenação online ou quotas/reservas | Antes de habilitar garantia global em 06/13 |
| Web (P02) | Consulta + cadastros online; sem concluir venda/caixa pela web | Antes de acrescentar mutações financeiras remotas |
| Acesso offline/perfis (P08/P12) | Usuários provisionados; janela de sete dias é apenas proposta antiga | 04; não impor prazo oculto |
| Fiado e recorrências com vários terminais | Um terminal responsável por escritor/agenda; demais consultam | 15/16; concorrência financeira offline exige decisão própria |
| Custeio, legado, backup/suporte (P07/P10/P11/P13) | Custo desconhecido explícito; ensaio e cópia fora do disco | 06/14/18/19 conforme dependência |
| Fotos e assistente real (P15/P16) | Preparar pontos de extensão; nada conectado automaticamente | 17/18; tela simulada T24 não é autorização de reset real |

## Fontes e precedência

Base: [backend](../../docs/backend.md), [dados/sincronização](../../docs/banco-de-dados-e-sincronizacao.md), [decisões](../../docs/decisoes-e-pendencias.md), [plano geral](../../docs/plano-de-implementacao.md), [Windows](../../docs/windows.md), [frontend](../../docs/frontend.md), [análise](../../docs/analise-geral.md) e [objetivo](../../docs/Objetivo.txt). As partes detalham esses guias; instruções posteriores do responsável prevalecem. Este roteiro não autoriza publicar, conectar contas, criar bancos nem desenvolver agora.

Consultas oficiais em **24/11/2026**: [schemas do Fastify](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), [geração OpenAPI](https://github.com/fastify/fastify-swagger), [Swagger UI](https://github.com/fastify/fastify-swagger-ui), [validação OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html), [bloqueios MySQL](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html), [WAL SQLite](https://www.sqlite.org/wal.html) e [limites Hostinger](https://www.hostinger.com/support/hostinger-node-js-limits-for-web-and-cloud-plans/). São fundamentos para as propostas; compatibilidade e recursos da instalação serão verificados novamente na implementação.

**Verificação documental desta entrega — 24/11/2026:** conferidos os 20 arquivos, sequência 01–19, dependências e 125 links locais considerando este roteiro e os guias gerais. Nenhuma parte marcada FEITO, nenhum arquivo de código criado em back-Venprox e nenhum teste de backend executado: os testes descritos são critérios para as implementações futuras.
