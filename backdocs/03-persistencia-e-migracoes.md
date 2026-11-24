# B03 — Persistência, transações e migrações

**Estado:** planejada. **Dependências:** B01–B02. [Sumário](00-SUMARIO.md). **Conexão:** suporta os módulos locais e remotos; não cria todas as tabelas opcionais de uma vez.

## Objetivo e responsabilidades

Implementar portas de repositório e UnitOfWork, com adaptadores SQLite e MySQL/InnoDB separados. Casos de uso controlam a fronteira transacional; todos os repositórios envolvidos recebem a mesma conexão/transação. Um repositório não pode fazer commit próprio no meio de uma venda.

SQL fica na infraestrutura. Usar query builder/driver pequeno e migrations explícitas se isso preservar transparência; ORM não é requisito, e será escolhido pela compatibilidade real dos dois motores, migrações e empacotamento. Não prometer SQL universal.

## Passo a passo

1. Validar identidade da loja/diretório e conexão, distinguindo base ausente, permissão, rede, disco cheio, corrupção e versão incompatível.
2. Criar históricos separados de migração, com número, checksum, estado e exclusão mútua. Aplicar alterações somente pelo mecanismo de migração.
3. Provar transação de agregado + outbox + auditoria, rollback e conflito de unicidade com dados técnicos de teste.
4. Definir interfaces de transação e traduções seguras de erro (ocupado, indisponível, unique, FK, deadlock). Nada de mensagem SQL devolvida à tela.
5. Adicionar tabelas de negócio incrementalmente na parte dona do módulo; constraints e testes acompanham a migração. Catálogo de tabelas fica no guia geral de dados, não em uma enorme primeira migration.
6. Preparar backup consistente mínimo e procedimento para falha de migration antes de gravar dados de negócio. B18 completa a recuperação operacional.

## Banco local

- Arquivo em diretório de dados estável fora dos binários, nunca pasta SMB/OneDrive sincronizada ao vivo.
- foreign_keys por conexão, WAL, synchronous=FULL, espera limitada por bloqueio e transações curtas. Conferir versão SQLite corrigida realmente embarcada.
- Um dono da escrita por terminal; leituras longas não podem impedir checkpoint indefinidamente. Relatórios pesados fora da transação de venda.
- Sequência do dispositivo, alterações locais e outbox na mesma transação. Falha de escrita não retorna sucesso.
- Snapshot/backup consistente pela API apropriada; não copiar somente .db aberto ignorando WAL.

## Banco remoto e constraints

Usar engine transacional, utf8mb4 e política explícita de collation por campo. Testar no motor/versão reais; MariaDB não é automaticamente idêntico ao MySQL escolhido.

Constraints mínimas ao introduzir cada módulo: ID global; código normalizado e barcode únicos por loja; uma sessão aberta por terminal; intenção/operação e device_seq únicos; movimento único por origem/tipo/item; referência cruzada sempre da mesma loja. Ter banco dedicado não dispensa validar store_id.

Sequências BIGINT não passam por Number sem faixa segura. Definir índices a partir das consultas de cada parte, sem indexar tudo. Escolher ordem comum de locks e retentativa limitada da **transação inteira** após deadlock, preservando IDs; nenhum efeito externo deve estar dentro dessa retentativa.

MySQL pode fazer commit implícito em DDL. Migration remota precisa de passos verificáveis e retomáveis, sem alegar rollback de todo o DDL. Usuário de migração separado da API; terminais jamais executam DDL remoto.

## Contratos e integração

Não cria CRUD HTTP genérico de tabelas. Diagnóstico interno informa schema, estado de migration e disponibilidade sem segredo. A aplicação depende das portas; rotas só chegam nas partes de negócio.

Operações que alteram catálogo na web precisarão da publicação B11. Até lá, exercitar em banco isolado; não disponibilizar mutação real em produção com log ausente. Outbox local nasce aqui como infraestrutura e cada módulo registra seu evento versionado.

## Critérios para FEITO

Testes em SQLite real e MySQL real: instalar do zero, reaplicar, migrar versão anterior, simular falha/retomada, checksum divergente, rollback agregado/outbox, duas transações concorrentes, FK, limites numéricos, disco/banco indisponíveis. Validar backup mínimo restaurável.

Registrar drivers/engines, parâmetros, migrations, índices, comandos e resultados. **Próxima:** B04. Referências: [dados §§3–4/10–11](../../docs/banco-de-dados-e-sincronizacao.md), [SQLite WAL](https://www.sqlite.org/wal.html), [commit implícito MySQL](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html).
