# B18 — Backup, recuperação e importação de dados

**Estado:** planejada. **Dependências:** núcleo B01–B14; incluir B15–B17 conforme implementados. [Sumário](00-SUMARIO.md). **Telas:** T23 e ligação futura opcional T24.

## Objetivo e separação

Provar que dados, histórico e fila podem ser restaurados com identidades preservadas. Backup básico começa em B03; esta parte completa o procedimento operacional. Sincronização replica estado recebido e não substitui cópias independentes.

Aplicação coordena verificação/reconciliação; infraestrutura produz cópia consistente, arquivos/manifesto e restaura em área isolada; processo principal controla acesso aos caminhos. Nenhuma rota pública executa restauração destrutiva do banco remoto.

## A. Backup e restauração

1. Aprovar P11: RPO/RTO, frequência, retenção, local fora do disco, criptografia/chaves e responsável. Sugestões antigas (local horário/fechamento e remoto diário) não são SLA já aceito.
2. SQLite: backup consistente com banco/WAL tratados pelo mecanismo correto; não copiar apenas arquivo aberto. Incluir outbox, identidade, sequência, cursores, autorizações compatíveis e arquivos pendentes necessários.
3. Remoto: cópia independente com dados de negócio, inbox/recibos, log/controle de versões e material necessário à recuperação. Segredos/chaves têm cópia protegida separada, sem enviá-los aos terminais.
4. Ensaiar restauração em diretório/banco separado: integridade, foreign keys, loja, versão, manifesto, contagens, saldos e totais.
5. Confrontar recibos remotos antes de reenviar operações recuperadas; manter IDs originais e não executar casos de uso de venda/quitação novamente durante importação do estado.
6. Se contador/identidade antiga foi perdido, usar nova identidade/geração para operações futuras após procedimento autorizado; operações resgatadas conservam origem. Não manter clones ativos do mesmo device.

Só nuvem disponível recompõe apenas o recebido, com corte/último contato explícitos. Nunca tratar computador perdido como sem pendências; fatos não enviados precisam de cópia sobrevivente e podem ser irrecuperáveis.

## B. Snapshot e reutilização local

Usar os snapshots B11: catálogo inicial não basta para recuperação operacional. Incluir fiado/recibos e agenda/regras/ocorrências se módulos entregues, com movimentos associados e configurações confirmadas.

Baixar páginas para área temporária; retomar mesma captura, conferir manifesto/corte, aplicar posteriores e preservar/reconciliar qualquer outbox existente. Promover somente após verificação completa e com recuperação do estado anterior em caso de falha.

Reinstalar binários preservando base íntegra mantém vendas não enviadas e pode manter device/seq. Banco suspeito requer preservação e diagnóstico de permissão/disco/versão antes de alegar corrupção. Não criar banco vazio como reparação.

**Assistente T24/E9:** interface já simulada não implementa nem autoriza apagar dados reais. Automatizar escolha de base/desinstalador é entrega opcional separada, usando estes mesmos serviços e revisão explícita de escopo. Reset local não emite DELETE remoto nem altera loja; exclusão física não faz parte da implementação padrão desta parte.

## C. Importação do legado

1. Obter amostra/exportação autorizada P07; não presumir acesso ao banco do fornecedor.
2. Fazer staging e dry-run com mapeamento explícito de código, barcode, unidade, valor, cliente e dívida. Validar B02, sem remover zeros nem executar conteúdo de CSV/planilha.
3. Atribuir IDs estáveis por origem/lote, listar rejeições e duplicidades sem fusão por nome.
4. Saldos iniciais viram movimentos identificados; dívida histórica vira origem de abertura auditável, sem nova venda/caixa. Histórico importado mantém classificação própria.
5. Conferir contagens, amostras e totais; repetir lote não duplica. Executar corte/retorno aprovado antes de produção.

## Contratos e critérios para FEITO

IPC administrativo: recovery.inspect, recovery.prepareCopy, recovery.validateCopy e recovery.getReport; promoção somente em fluxo autorizado, com estado de atendimento seguro. Caminhos selecionados/permitidos, sem file access genérico. HTTP reaproveita snapshots/recibos e GET /admin/backups/status sem expor cópias/chaves publicamente.

Ensaio obrigatório: backup antigo com operações já recebidas + pendentes; resposta perdida; rede interrompida na reconstrução; base de outra loja; contador perdido; corrupção/disco cheio; RF23 com fiado/agenda entregues. Conferir IDs/totais e ausência de novos efeitos de venda/caixa/estoque.

Registrar evidência restaurável, local das cópias, tempos medidos, perda conhecida e lacunas. **Próxima:** B19. Referências: [dados §§7/11–12](../../docs/banco-de-dados-e-sincronizacao.md), [Windows §12](../../docs/windows.md).
