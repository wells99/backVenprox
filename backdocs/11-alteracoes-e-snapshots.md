# B11 — Log de alterações, cursor e snapshots

**Estado:** planejada. **Dependências:** B01–B10. [Sumário](00-SUMARIO.md). **Conexão:** fecha a publicação atômica das escritas B05/B10; fornece download para B12.

## Objetivo e responsabilidade

Baixar mudanças sem pular commits concorrentes e fornecer captura de estado com corte coerente. Aplicação define eventos/abrangência; infraestrutura implementa barreira, log e materialização; HTTP pagina conteúdo fixo. Não usar updated_at, UUID ou MAX(id) como prova de tudo recebido.

Dados: store_sync_sequence, server_changes, manifestos/capturas de snapshot e estado de retenção. Cursor é string decimal opaca ao frontend; servidor controla ordenação.

## Passo a passo do log

1. Todos os escritores web e sync participam da mesma disciplina: bloquear linha da sequência da loja antes de atribuir cursor e manter até commit.
2. Gravar alterações e negócio na mesma transação; rollback não publica fato inexistente. Auto-incremento sozinho não prova ordem de commit.
3. Adotar ordem comum de locks entre handlers, publicada em B03, para reduzir deadlocks; retentativas são da transação inteira com mesmos IDs.
4. GET por cursor aplicado, limite e ordenação estável. Devolver maior cursor efetivamente incluído; nunca um teto ainda não retornado.
5. Versionar eventos e tombstones/inativações. Clientes compatíveis reconhecem eventos opcionais; mudança obrigatória desconhecida interrompe com orientação.
6. Definir retenção e piso disponível. Cursor anterior ao piso retorna SNAPSHOT_REQUIRED; download vazio não representa atualização nesse caso.

## Snapshot inicial versus operacional

**Inicial:** catálogo, configurações e referências/autorização necessárias ao terminal novo, com manifesto e cursor de corte. Não clonar sessão/identidade de outro caixa.

**Operacional:** tudo recebido necessário para recompor a operação: vendas/itens/pagamentos/reversões, caixas/movimentos, estoque, clientes, fiado/recibos e lembretes/ocorrências quando entregues. Preservar IDs/histórico, sem gerar casos de uso novos. Excluir segredos de servidor e credenciais de outros terminais.

Fixar conteúdo/corte num estado consistente. Nesta parte, materializar captura pequena dentro de limites de tempo/tamanho medidos, com barreira curta testada. Captura grande precisa de leitura consistente/captura imutável com prova equivalente e poderá usar job após B13; até lá, retornar limite explícito, sem enfileirar trabalho inexistente. Não manter a trava da loja durante o download nem montar páginas a partir de tabelas vivas em momentos diferentes.

## Rotas sob /api/v1

| Rota | Contrato |
| --- | --- |
| GET /sync/changes?after=...&limit=... | Página ordenada, next_cursor e piso/versões |
| POST /sync/snapshots | Solicita tipo autorizado; retorna captura pronta nos limites provados; modo 202/job somente após B13 |
| GET /sync/snapshots/:id | Manifesto: loja, corte, versões, contagens, checksums e estado |
| GET /sync/snapshots/:id/pages/:page | Página da captura imutável autorizada, retomável |

Essa API detalha o antigo GET /sync/snapshot dos guias; não implementar dois mecanismos. Preferir o recurso de snapshots acima, registrando a substituição no contrato. Snapshot operacional requer autorização de recuperação além da credencial comum de download; incluir vínculo ao terminal de destino e validade, sem URL pública.

Expiração devolve estado explícito; cliente pode retomar mesmo snapshot enquanto válido. Download interrompido não altera base em uso. B12/B18 instalam em área separada e aplicam mudanças posteriores ao corte.

## Critérios para FEITO

Testar transações A/B que tentam publicar em ordem diferente, paginação com escrita concorrente, rollback, empates e reconexão. Nenhuma mudança confirmada fica atrás do cursor já entregue.

Snapshot com escrita concorrente deve corresponder ao manifesto/corte; página repetida tem mesmo conteúdo, loja errada é recusada e captura expirada não se mistura a outra. Ensaiar presença de módulos opcionais por versão.

Registrar plano de retenção/barreira, duração/impacto medidos, testes e rotas OpenAPI. **Próxima:** B12. Base: [dados §7](../../docs/banco-de-dados-e-sincronizacao.md).
