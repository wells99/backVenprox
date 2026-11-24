# B02 — Contratos, validação, normalização e OpenAPI

**Estado:** planejada. **Dependências:** B01. [Sumário](00-SUMARIO.md). **Conexão:** obrigatório para todos os adaptadores e rotas posteriores.

## Objetivo e escolha

Estabelecer uma única definição de entrada/saída por operação. Proposta: JSON Schema como fonte de contratos, Fastify para validação/serialização, @fastify/swagger para OpenAPI e @fastify/swagger-ui para navegação. É suficiente para documentar/testar cada rota sem manter Swagger manual separado dos handlers. Tipos TS devem ser inferidos/gerados desse contrato; escolher biblioteca auxiliar compatível em B01, sem dois schemas contraditórios.

Preferir OpenAPI 3.0.3 inicialmente, ou outra versão comprovadamente suportada pelo conjunto escolhido; não adotar a mais recente apenas pelo número. Registrar o gerador antes das rotas no modo dinâmico e conferir que todas apareceram.

## Padrão entre frontend, HTTP, IPC e sincronização

- HTTP de negócio com prefixo /api/v1. Exemplos nas demais partes já pressupõem esse prefixo; /health e documentação são exceções explícitas.
- Campos JSON em snake_case; enums técnicos estáveis em inglês. Adaptador do frontend converte para camelCase/rótulos portugueses já usados nas telas.
- Valores em centavos inteiros dentro de faixa segura validada; quantidade em quantity_milli. BigInt/cursores e números fora da faixa segura viajam como strings decimais, nunca truncados por JSON/driver.
- UUID canônico; instantes UTC em ISO 8601, data comercial e zona IANA separadas. Ausente, null e string vazia têm semântica explícita por campo; PATCH ausente preserva valor.
- Sucesso: objeto com data e meta; meta contém request_id e, quando aplicável, next_cursor, scope, as_of e estado de sincronização. Coleções sempre em data.items. Não colocar mensagens de erro dentro de HTTP 200 comum.
- Erro: objeto error com code estável, message em português, field_errors com path/code/message, retryable e request_id. Não expor stack, SQL, segredo ou valor sensível. IPC reutiliza o resultado tipado, sem inventar status HTTP para canal nativo.

Exemplo conceitual de erro de negócio:

~~~json
{
  "error": {
    "code": "CASH_SESSION_REQUIRED",
    "message": "Abra o caixa antes de concluir a venda.",
    "field_errors": [],
    "retryable": false,
    "request_id": "identificador-de-correlacao"
  }
}
~~~

400 para JSON malformado; 422 para schema/campo/regra de conteúdo; 401 para ausência/expiração de autenticação; 403 para proibição; 404 sem revelar dados de outra loja; 409 para versão/estado/idempotência conflitantes; 429 para limite, com Retry-After quando conhecido. 503 pode ser transitório; 500 inesperado exige consulta/reenvio idempotente, não repetição cega de novo comando. POST síncrono retorna 201 na primeira criação e resultado recuperável no replay; 202 somente para job durável ainda não concluído. /sync/push possui recibos individuais, não equivalência entre HTTP 200 e todas as operações aplicadas.

## Limpeza de entrada com política por campo

1. Limitar tamanho/content-type/profundidade e quantidade de itens antes de processamento caro. Schemas são código do projeto, nunca fornecidos pelo usuário.
2. Rejeitar propriedades desconhecidas em DTOs de comando com additionalProperties:false. Configurar Ajv para não removê-las silenciosamente nem converter tipos do corpo por padrão; Fastify tem defaults mutáveis, portanto testar a configuração efetiva. Conversão de query/params somente explícita.
3. Para nomes/descrições: normalização Unicode NFC, trim externo e limites por campo após normalizar. Preservar acentos, caixa e pontuação na apresentação; controles invisíveis indevidos são rejeitados. Espaços internos e quebras de linha variam: nome simples não recebe o mesmo tratamento de observação multilinha.
4. Chave de pesquisa derivada pode ignorar acento/caixa sem substituir o original. Código interno usa chave canônica documentada, proposta trim + NFC + maiúscula invariável; barcode permanece texto com zeros e caracteres permitidos conforme formatos aceitos. Unique index deve usar exatamente a mesma normalização.
5. Login possui chave normalizada própria; nome de pessoa não é único. Senha, token, assinatura e conteúdo canônico de operação **não** passam por trim, remoção de acentos ou limpeza genérica. Verificar hash de sync sobre o conteúdo original versionado antes de qualquer transformação.
6. Não remover aspas/trechos SQL como defesa: parametrizar SQL, permitir apenas sort/campos enumerados e escapar LIKE quando a busca for literal. Texto é texto; React renderiza escapado, sem HTML arbitrário.
7. Validar semântica no caso de uso após schema: permissão, soma de pagamentos, versão e estado. Validação de formato não consulta banco; normalização não substitui autorização.

## Rotas, documentação e testes

Disponibilizar /docs e /openapi.json em desenvolvimento. Em produção, exigir autenticação/restrição para ambos ou desabilitá-los, inclusive os recursos auxiliares da UI; não assumir que ocultar a interface protege a API.

Cada rota entregue deve ter tag, operationId único, descrição, schema de params/query/body/response por status, segurança, limites, exemplos fictícios, códigos de erro e idempotência/versão quando aplicáveis. IPC terá mapa comando → DTO → permissão → caso de uso; não publicar rotas HTTP de venda só para aparecerem no Swagger.

**Critérios para FEITO:** contrato validado e OpenAPI exportável; teste compara inventário de rotas registradas à documentação, valida exemplos e serialização de saída. Cobrir Unicode composto/decomposto, zeros de barcode, dinheiro inválido, propriedade desconhecida, payload grande, SQL como texto, senha preservada e campo privado ausente na resposta. Toda nova parte amplia esses testes.

Referências: [Fastify schemas](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), [Swagger](https://github.com/fastify/fastify-swagger), [UI](https://github.com/fastify/fastify-swagger-ui), [OWASP validação](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html), consultados em 24/11/2026. Registrar comandos/resultados e próxima B03 ao concluir.
