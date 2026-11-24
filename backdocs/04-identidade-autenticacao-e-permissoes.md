# B04 — Identidade, autenticação e permissões

**Estado:** planejada. **Dependências:** B01–B03. [Sumário](00-SUMARIO.md). **Conexão:** todos os casos de uso recebem contexto autorizado, inclusive IPC.

## Objetivo e limites

Proteger setup, usuários e terminais sem tornar vendas offline dependentes de um token web vigente. Uma implantação/banco por loja; vários devices nessa loja. Não distribuir senha MySQL nem hashes de todos os usuários aos caixas.

Domínio define permissões e estados; aplicação valida contexto/escopo; adaptadores autenticam transporte; infraestrutura guarda sessão, verificador e segredos. O frontend pode ocultar botão por conveniência, mas não decide autorização.

## Passo a passo

1. Migrar stores/installation, devices, users/roles, sessões/renovações e registros de autorização offline minimizados. Separar identidade da loja, terminal e operador.
2. Setup exige token de instalação temporário, de uso único; cria administrador em transação e fecha definitivamente. Recomendar senha definida pelo dono ou temporária única, sem admin/admin público.
3. Autenticar online com hash de senha apropriado, proposta Argon2id com parâmetros medidos e revistos. Limitar tentativas, respostas sem enumeração e sessões revogáveis.
4. Parear terminal mediante administrador online e autorização de uso único; gerar credencial restrita por dispositivo, código CX01/CX02/CX03 e contador persistido próprio.
5. Autorizar usuário previamente validado online para operar offline nesse terminal. Guardar apenas material mínimo protegido pelo Windows, sem segredos no renderer/localStorage.
6. Versionar permissões e registrar a autorização de origem nas operações; credencial de sync autentica dispositivo e não concede CRUD administrativo.
7. Implementar revogação/rotação e trilha de auditoria; não apagar fila pendente ao perder acesso.

## Rotas e comandos propostos

Todos os caminhos de negócio usam /api/v1:

| HTTP | Permissão/resultado |
| --- | --- |
| POST /setup/activate | Token de instalação; primeiro admin, sem reabertura por banco vazio acidental |
| POST /auth/login, /auth/refresh, /auth/logout | Sessão online conforme canal |
| GET /auth/me | Usuário/permissões e validade autorizada, sem hash/token privado |
| POST /devices/enroll | Administrador e convite temporário; identidade da mesma loja |
| GET /admin/devices; POST /admin/devices/:id/revoke | Administração, metadados seguros e revogação auditada |
| GET/POST /admin/users; PATCH /admin/users/:id | Gestão online, versão/idempotência e trilha |

IPC: auth.loginOffline, auth.getContext, auth.logout e device.getStatus com schemas próprios. Não criar usuário offline desconhecido ou endpoint remoto genérico para executar comandos locais.

Na web, cookies HttpOnly/Secure/SameSite, proteção CSRF e origem; preferir mesma origem. Refresh desktop/dispositivo fica no armazenamento protegido via processo principal. Validar sender/frame do IPC e expor somente métodos nomeados no preload.

## Permissões e pendências

Matriz inicial a revisar em P08: consultar/vender, abrir/fechar caixa, suprir/sangrar, desconto limitado, ajustar estoque, cancelar/restituir, ver custos, alterar cadastros/configurações, fiado e recuperar dados. Operador não herda administrador por falta de regra.

Janela offline de sete dias é **proposta**, não aprovada. Definir prazo/avisos/recuperação antes de habilitar o modo real. Sem rede não existe revogação instantânea; registrar versão e anomalia de relógio sem reescrever fatos.

Operações autorizadas quando criadas não são rejeitadas só porque a sessão online expirou antes do envio. Origem ambígua/revogada exige revisão/quarentena B10/B12. A credencial de terminal não autoriza fabricar permissão ou escolher store_id de outra loja.

## Critérios para FEITO

Setup paralelo cria um admin; reabertura/erro de rede não reativa setup. Testar usuário/terminal de outra loja, CSRF/origem, refresh revogado, repetição de convite, usuário não provisionado offline, limites de tentativas e acesso direto HTTP/IPC sem permissão. Verificar redaction e ausência de segredos em DTO/OpenAPI.

Documentar configuração de acesso offline e fronteiras de revogação, comandos/testes e migrações. **Próxima:** B05. Base: [backend §6](../../docs/backend.md), [decisões P08/P12](../../docs/decisoes-e-pendencias.md), [Windows](../../docs/windows.md).
