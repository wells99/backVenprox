# B19 — Homologação, implantação e operação

**Estado:** planejada. **Dependências:** B01–B14 e B18; complementos apenas quando escolhidos/entregues. [Sumário](00-SUMARIO.md). **Conexão:** liberação controlada, não desenvolvimento de novos módulos.

## Objetivo

Reunir provas produzidas nas partes anteriores e autorizar tecnicamente um piloto. Testes não começam aqui: cada parte tem aceite próprio. Esta etapa confirma o sistema integrado, versão empacotada, hospedagem, recuperação e rotina de suporte.

## Matriz mínima de evidências

| Grupo | Demonstração exigida |
| --- | --- |
| Contratos | Todas as rotas documentadas/testadas, schemas de saída e erros estáveis; IPC catalogado |
| Domínio | Centavos, rateio, troco, limites, custo desconhecido e snapshots históricos |
| Local | Venda offline, duplo comando, falha antes/depois de commit, reinício e disco cheio |
| Remoto | Inbox/efeitos atômicos, 100 reenvios, resposta perdida, conflitos e ordem do log |
| Vários caixas | Três devices/SQLite/caixas, vendas simultâneas e reconexão em ordens diversas |
| Workers | Um/dois executores, lease expirada, morte após efeito, idempotência e partições |
| Recuperação | Backup antigo, snapshot operacional, pendências preservadas e prevenção de clone |
| Segurança | Setup fechado, loja errada, sessão/CSRF/IPC, permissão direta e segredo ausente |
| Frontend | Jornadas e teclado existentes com adaptadores reais, sem fallback falso para demo |
| Complementos | Fiado/agenda/print entregues passam CA17/CA19/CA20/CA23; fotos só se implementadas |

Executar integração com SQLite e motor remoto reais; mocks servem para falhas pontuais, não provam locks/transações. Preservar scripts, massa fictícia, relatórios e capturas necessárias para repetir. Não expor dados de cliente nas evidências.

## Carga e dimensionamento

Usar máquina e banco de referência acordados. Medir p50/p95/p99 da conclusão local, busca, push/recibos, locks, pool e duração/idade da fila, com três terminais e jobs em paralelo.

Metas antigas de busca p95 até 200 ms, commit local até 500 ms e tentativa de sync até 30 s são propostas RNF04/RNF05, não resultados. Rede/impressão ficam fora do tempo de commit. Drenar 10.000 operações com pausas/reinícios e reconciliar conteúdo.

Somar conexões de todas as APIs/workers; não elevar concorrência se só aumentar disputa da barreira/IO. Registrar configuração/limite suportado. Três caixas são cenário mínimo de ensaio solicitado, não capacidade máxima garantida sem medição.

## Implantação por loja

1. Confirmar plano/engine/Node/agendador/workers/HTTPS/backups e Windows/driver reais, sem congelar suporte a partir dos guias antigos.
2. Provisionar banco, store_id, domínio, usuários de API/migração e segredos exclusivos. Um código/artefato versionado para lojas diferentes, sem copiar base/credencial entre elas.
3. Aplicar migrações com exclusão mútua e backup, plano de falha/retomada e compatibilidade com filas antigas. Atualização não deve inutilizar pendências de protocolo anterior dentro da janela suportada.
4. Configurar origem/CORS/cookies/CSP, limites de corpo/conexão, proxy confiável explícito, timeouts, rate limits compartilhados e logs redigidos.
5. Subir API e executores conforme ambiente autorizado; /docs e /openapi.json protegidos ou desativados. Não expor banco e diagnóstico interno à internet.
6. Ativar admin uma vez, parear terminais, instalar snapshots e executar jornada de teste antes de dados reais.
7. Homologar o pacote Windows sem exigir npm na loja, caminhos estáveis, permissões, segunda instância e encerramento; comprovar serviço local sem rede.
8. Migrar dados aprovados, conferir corte/totais, ensaiar retorno e só então iniciar piloto assistido.

Implantação externa, credenciais reais e dados de cliente dependem da autorização da etapa operacional correspondente. Este roteiro de documentação não executa nenhuma dessas ações.

## Observabilidade e suporte

Logs: request_id/operation_id/device_id, versão, ação, resultado e duração, sem senhas/tokens/dados pessoais completos. Métricas: último contato/recibo por terminal, fila conhecida/idade, conflitos/quarentena, leases/falhas de jobs, commit/locks, disco e backup.

Alertas e responsável P13 definidos antes do piloto. Ausência de telemetria indica unknown/último estado recebido. Fornecer procedimentos de fila bloqueada, credencial expirada, disco cheio, migração interrompida, rollback de aplicação compatível e restauração; rollback de binário não apaga schema nem fila automaticamente.

## Critérios para FEITO

Núcleo CA01–CA16/CA18/CA21 aplicáveis demonstrado, recuperação e escopo efetivo de complementos aceitos, defeitos impeditivos resolvidos, evidências/versões/configuração registradas e responsável confirma o piloto/transição. CA24/CA25 permanecem condicionais às implementações escolhidas; não exigir fiscal/integração bancária para liberar esta versão.

Registrar o que está pronto, o que continua adiado e o procedimento de suporte. Fechar esta parte não permite afirmar “recuperação de dados nunca enviados” nem “estoque global garantido offline”.

Base: [plano E7/E8](../../docs/plano-de-implementacao.md), [requisitos e aceite](../../docs/analise-geral.md), [Windows](../../docs/windows.md). Ao retomar outra IA deve começar pelo sumário e pela primeira parte ainda não concluída.
