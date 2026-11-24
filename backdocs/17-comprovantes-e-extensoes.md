# B17 — Comprovantes e pontos de extensão

**Estado:** planejada. **Dependências:** B01–B14; independente de B15/B16. [Sumário](00-SUMARIO.md). **Telas:** T04/T05/T11/T22.

Esta parte tem três recortes independentes. Registrar cada um como implementado, apenas contrato ou adiado; não marcar fotos/emissão fiscal como feitas por existir uma interface. Extras não condicionam a venda nem o piloto.

## A. Impressão do comprovante não fiscal

Objetivo: imprimir snapshots da venda salva, inclusive avulsos, sem depender da nuvem. Domínio fornece conteúdo; aplicação solicita trabalho; adaptador nativo envia à impressora homologada. Renderer não envia código arbitrário de impressora ou caminho livre.

1. Migrar device_print_settings e receipt_jobs locais: impressora/perfil, automático inicialmente falso, venda, finalidade, chave de deduplicação e estado.
2. Quando ativo, persistir intenção automática vinculada à conclusão de forma atômica, ou detectar vendas elegíveis com reconciliação idempotente. Executar impressão somente após commit; queda entre commit e despacho não pode esquecer permanentemente o trabalho.
3. Unique de venda/finalidade garante um trabalho automático. Reimpressão exige intenção nova explícita; nunca concluir a venda de novo.
4. Trabalho guarda snapshot/layout versionado; papel identifica **comprovante de venda não fiscal**. Perfis comum/cupom dependem de hardware/driver P05.
5. Falha certa permite ação adequada; resultado físico incerto é apresentado como incerto. Não prometer exatamente uma via física nem reimprimir automaticamente sem critério.

IPC: receipts.getPreview, receipts.requestPrint, receipts.getJob e printSettings.change. HTTP /api/v1/sales/:id/receipt pode fornecer representação autorizada não fiscal para consulta; não expõe comando de impressora local.

Aceite: padrão não imprime, ativação imprime após commit, falha não desfaz venda, reimpressão não duplica caixa/estoque e reinício recupera intenção. Testar impressoras realmente aprovadas, sem declarar homologação por PDF de demonstração.

## B. Porta fiscal futura, sem provedor

Definir na aplicação FiscalGateway com operações conceituais emitir/consultar/cancelar e resultado próprio. Estado not_configured/not_requested; chave idempotente vinculada à venda e acionamento pós-commit se um dia habilitado.

Não implementar provedor, tributos, XML, campos obrigatórios de nota ou endpoints de emissão agora. Porta não é serviço fiscal pronto, e impressora de cupom não transforma o comprovante em documento fiscal.

Aceite deste recorte: contrato e estado desabilitado testados, nenhuma chamada externa ou bloqueio fiscal na venda/impressão. Emissão efetiva terá escopo/provedor/migrações/testes próprios antes de código.

## C. Fotos no Drive — extra posterior E10

**Adiado por padrão.** Esta descrição prepara a retomada; não conectar conta nem criar tabelas de mídia antecipadamente. product_images_enabled ausente/falso é suficiente no núcleo.

Quando houver orientação específica, revisar P16 e políticas Google, então:

1. OAuth pelo backend para conta dedicada da loja; projeto OAuth próprio é alternativa avançada. API key comum não autoriza arquivos privados. Login Google não substitui login do operador.
2. Migrar storage_connections e product_media: produto → conexão da mesma loja → provider_file_id e metadados. Sem segredo por produto nem URL temporária como identidade.
3. Proteger refresh token/segredo no servidor, fora do snapshot dos terminais; consentimento/estado/PKCE conforme fluxo aprovado. Não pedir senha Google no PDV.
4. Salvar produto sem esperar foto; fila de mídia independente, chaves estáveis e consulta/reconciliação de upload incerto antes de repetir.
5. Leitura autorizada pela API e cache de miniaturas; validar MIME real, tamanho/dimensões, recursos de decodificação e propriedade do arquivo. Não permitir proxy de URL arbitrária/SSRF nem publicar arquivo automaticamente.
6. Falha/revogação/cota cheia não bloqueia produto, venda ou sync financeiro. Desativar/reinstalar não apaga Drive automaticamente.

Rotas **somente propostas para E10**, sob /api/v1: POST /integrations/drive/authorize, GET /integrations/drive/callback, GET /integrations/drive/status, POST /products/:id/media e GET /product-media/:id/content. Definir reconexão/desvinculação, limites e esquemas ao implementar; só então entram na OpenAPI operacional.

## Conclusão e registro

Para marcar o escopo autorizado como FEITO, explicitar no topo quais recortes foram entregues e quais permanecem contratos/adiados, preservando o estado E10 planejado no sumário. Não exigir fotos nem emissão fiscal para dar por concluída a impressão escolhida.

Testar falha de impressora e ausência de provedor agora; CA25 será coberto apenas quando mídia existir. Registrar migrations, limites, testes, hardware e próximo B18.

Base: [backend §§4.7–4.8](../../docs/backend.md), [dados §§4.4/13](../../docs/banco-de-dados-e-sincronizacao.md), [Windows](../../docs/windows.md). Revalidar fontes externas Google/fiscais na etapa correspondente.
