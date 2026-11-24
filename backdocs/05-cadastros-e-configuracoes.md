# B05 — Cadastros e configurações versionadas

**Estado:** planejada. **Dependências:** B01–B04. [Sumário](00-SUMARIO.md). **Telas:** T10–T12, T15–T16, T22 e seleção de cliente/produto na venda.

## Objetivo e camadas

Entregar catálogo e cliente mínimo utilizáveis pela operação local. Domínio valida identidade, estado e valores; aplicação aplica permissão/versão; repositórios mantêm unicidade; transporte recebe DTOs B02 e retorna apenas campos autorizados.

Dados: categories, products, product_barcodes, customers e store_settings, com ID, loja, versão, ativo e auditoria. Preferências exclusivas do terminal são separadas das configurações da loja. Não adicionar credenciais Google/colunas de fotos em products.

## Sequência de implementação

1. Migrar categoria, produto e cliente mínimo, com constraints de código normalizado/barcode e índices de busca.
2. Implementar criação idempotente, leitura paginada, alteração por expected_version, inativação e reativação; nenhuma exclusão física de cadastro referenciado.
3. Separar código interno de barcode. Preservar original e chave de busca; aplicar a política B02 antes da unicidade. Nome de cliente/categoria não serve de identidade.
4. Produto: descrição, unidade, preço, custo conhecido/opcional e ativo; categoria opcional e barcode ausente permitidos. Saldo só muda por B06, nunca por PATCH /products.
5. Cliente: nome obrigatório e dados opcionais mínimos; venda pode ser anônima. Não exigir documento/endereço nem usar CPF/nome para fusão automática.
6. Configuração da loja com versão: stock_policy padrão permissive. Impressão automática falsa por terminal; imagens ausentes/falsas. Campos administrativos não são mass-assigned a partir do payload.
7. Preservar base aceita e proposta local pendente. Implementar conflitos de versão sem última-data-vence, preparando B11/B12.

## Rotas e IPC

Caminhos abaixo sob /api/v1, todos autenticados:

| Recurso HTTP | Leitura | Escrita administrativa online |
| --- | --- | --- |
| /categories | GET lista; GET /:id | POST; PATCH /:id com versão |
| /products | GET lista; GET /:id | POST; PATCH /:id com versão |
| /customers | GET lista; GET /:id | POST; PATCH /:id com versão |
| /settings | GET conforme permissão | PATCH com versão e chaves permitidas |

POST usa Idempotency-Key; PATCH usa versão esperada e intenção estável para consultar resultado de resposta perdida. Inativar/reativar é alteração de estado auditada, sem DELETE genérico. Schemas de resposta omitem custo quando não autorizado.

IPC: catalog.search, products.proposeCreate, products.proposeUpdate, categories.proposeUpdate, customers.createMinimal, customers.proposeUpdate, settings.get e settings.change. Definir nomes finais no catálogo B02 sem atalhos SQL.

**Criação de produto completo:** proposta dos guias exige confirmação do servidor antes de disponibilizar no catálogo. O Windows registra proposta/outbox; offline, a proposta permanece pendente e o operador continua vendendo avulso. Cliente mínimo pode nascer com UUID offline para fiado. Rever essa distinção somente por decisão explícita, não copiando o mock da tela.

## Consistência e ligação com o restante

Escrita online aceita precisa publicar mudança B11 no mesmo commit; até essa dependência existir, rotas são testadas isoladamente e não liberadas em ambiente operacional. Todo comando local mutável registra outbox no mesmo commit. Venda conserva snapshot/versão efetiva, sem receber retroativamente novo preço ou política.

Consultas no Windows indicam base local e propostas pendentes. O navegador mostra somente estado confirmado. Alteração concorrente retorna 409 com versão atual/proposta segura; não apaga o rascunho da UI.

## Critérios para FEITO

Testar códigos com espaços/caixa/Unicode equivalentes, barcode 00123, colisão concorrente, resposta perdida/replay, PATCH obsoleto, inativação com histórico, venda anônima e resposta sem custo para usuário restrito. Configuração padrão permissiva/sem fotos/sem impressão deve sobreviver a reinício.

Registrar migrations, schemas, casos de uso, contratos e testes. **Próxima:** B06. Base: [backend §4.3](../../docs/backend.md), [dados §§2–4/8](../../docs/banco-de-dados-e-sincronizacao.md).
