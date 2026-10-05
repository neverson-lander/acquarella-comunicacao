# Acquarella · Central de comunicação

A versão atual de produção está em **[`vercel-app/`](vercel-app/README.md)**, com hospedagem na Vercel e banco PostgreSQL no Supabase: https://acquarella-comunicacao.vercel.app. Consulte o README dessa pasta para testes e publicação. O backend SQLite e o frontend da raiz são a versão local anterior.

Este repositório contém código, migrações e testes. Credenciais, bancos locais, logs, arquivos temporários e pacotes de implantação ficam fora do Git. Configure as variáveis do ambiente de destino a partir dos arquivos `.env.example` e vincule `vercel-app/` ao projeto Vercel existente antes de publicar.

Aplicação local funcional em português para centralizar Instagram Direct e Facebook Messenger, encaminhar mensagens para o WhatsApp da equipe e devolver respostas citadas ao canal de origem. Backend Node.js 24, banco SQLite persistente e frontend sem dependências externas.

## Executar

```powershell
node --env-file-if-exists=.env server.mjs
```

Abra http://127.0.0.1:3000 e crie o primeiro administrador. Não existe senha padrão. O primeiro cadastro deve ser concluído localmente antes de expor o serviço. A empresa inicial recebe contas e conversas explicitamente demonstrativas; essas contas não fazem requisições à Meta. A senha exige 12 caracteres.

```powershell
node --test tests/integration.test.mjs
```

## Funcionalidades

- Caixa de entrada com busca, filtros por canal e status, respostas e resolução de conversas.
- Configuração de várias contas de Instagram, Messenger e WhatsApp.
- Empresa inicial com WhatsApp da equipe **+55 34 98874-8139**.
- Perfis administrador, atendente e visualizador; seleção de contas autorizadas por usuário aplicada no servidor.
- Múltiplas empresas com separação por tenant em todas as consultas autenticadas. Um administrador pode provisionar outra empresa, mas não acessar seus dados. A nova empresa recebe login independente, com e-mail exclusivo.
- Senhas com scrypt e salt; sessões HttpOnly/SameSite com expiração em oito horas; proteção de origem e limitação de tentativas de login.
- Tokens e App Secrets criptografados com AES-256-GCM. A chave fica em `data/secret.key`; proteja a pasta com permissões do sistema e mantenha backup seguro junto do banco.
- Webhooks com assinatura HMAC, persistência e deduplicação; fila persistente; registros de falhas e entregas incertas.

## Fluxo do WhatsApp

1. Cliente escreve para uma conta profissional do Instagram ou uma página do Facebook.
2. A Meta envia o webhook. A central registra a conversa e agenda o encaminhamento.
3. **Outro número, registrado na WhatsApp Cloud API**, envia o texto para **+55 34 98874-8139**, o WhatsApp da equipe. O destinatário da equipe não é o Phone Number ID da API.
4. A equipe usa **Responder**, citando aquela mensagem. O webhook fornece `context.id`; a central cruza esse identificador com o encaminhamento persistido e envia a resposta para o cliente no canal original.

Mensagens sem citação nunca são atribuídas por suposição. Somente o telefone da equipe configurado é aceito para respostas pela ponte. O acesso físico a esse WhatsApp permite responder a todas as contas encaminhadas para ele; as permissões individuais do painel não se estendem ao aplicativo WhatsApp compartilhado. Use empresas/destinos separados se precisar de separação também no telefone.

## Conectar à Meta

1. Cadastre seu aplicativo, complete os requisitos de negócio/aprovação e obtenha tokens com as permissões de cada produto. Nenhuma conta real foi conectada automaticamente.
2. Configure primeiro a conta WhatsApp: Phone Number ID do número da API, token, App Secret e versão Graph API (padrão configurável `v25.0`).
3. Configure Instagram com **Instagram Login**, conta profissional, ID da conta Instagram, token e permissão `instagram_business_manage_messages`. O envio usa `graph.instagram.com/{version}/{id}/messages`.
4. Configure Messenger com ID da página, Page Access Token e permissões necessárias de mensagens/webhooks. O envio usa `graph.facebook.com/{version}/{page-id}/messages`.
5. Em cada conta, copie a URL `/webhooks/meta/{account-id}` e o token de verificação para o callback correspondente da Meta. É necessário HTTPS público. Assine o campo de mensagens para os ativos corretos. Se o mesmo produto exigir callbacks diferentes por ativo, configure as assinaturas/overrides suportados pela Meta ou use aplicativos separados. Cadastre o App Secret do aplicativo que assina aquele webhook.
6. Selecione a ponte WhatsApp em cada conta social. Ative o modo API real só após conferir os IDs e os tokens. O indicador de configuração não comprova conectividade.
7. Envie uma mensagem do WhatsApp da equipe ao número da API para abrir a janela de atendimento. Envie uma mensagem de teste ao Instagram/Messenger e responda citando o encaminhamento.

O envio de texto livre depende das janelas de 24 horas: a equipe precisa ter escrito para o número da API nas últimas 24 horas, e o cliente precisa ter escrito ao canal social nesse intervalo. Fora da janela WhatsApp seria necessário um template aprovado; **templates não estão implementados nesta versão**. Falhas ficam em Atividade. O painel continua recebendo as mensagens sociais mesmo se o encaminhamento falhar.

## Escopo e operação

Esta versão é um MVP executável, não uma implantação de produção concluída. Suporta mensagens de texto. Anexos recebidos aparecem como aviso para consultar o canal original; não há download/encaminhamento de mídia, OAuth automático, recuperação de senha por e-mail, templates, distribuição por atendente ou cobrança por tenant.

O processo é de instância única; SQLite e o worker local não devem ser compartilhados por réplicas concorrentes. A fila não reenvia automaticamente entregas incertas, evitando duplicação após timeout/reinício. Falhas de encaminhamento também não são reenviadas automaticamente; verifique o histórico antes de qualquer reenvio manual. Eventos inválidos são retidos no banco como falhos. O status “enviado” significa aceito pela API, não confirmação de leitura.

Para publicar, copie `.env.example` para `.env`, configure `HOST`, `PUBLIC_ORIGIN`, `NODE_ENV=production`, HTTPS em proxy reverso e armazenamento persistente. Configure backups, retenção dos dados e dos webhooks, monitoramento, rotação de credenciais e permissões da pasta `data`. A chave de criptografia e o banco devem ser preservados juntos. Cookies Secure requerem HTTPS em produção. Não inclua `.env` e `data/` no Git.

## Webhook HTTPS temporário para testes

O túnel de testes usa Cloudflare Quick Tunnel e um gateway local na porta 3002. O gateway publica `/webhooks/meta/{id}`, `/privacidade`, `/exclusao-de-dados` e `/privacy.css`; painel, login, demais arquivos e rotas `/api/` continuam locais na porta 3000. Assinaturas e limites de corpo permanecem ativos. O binário oficial `cloudflared` fica em `data/tools/` e foi validado contra o checksum SHA-256 do release da Cloudflare.

O endereço e os PIDs da sessão atual ficam em `data/tunnel-state.json`. Os logs ficam em `data/tunnel.log`, `data/gateway.log` e `data/gateway-error.log`. O endereço muda ao criar outro Quick Tunnel: atualize os callbacks na Meta. O computador, o servidor da central, o gateway e o túnel precisam permanecer ativos. Não há garantia de disponibilidade; use apenas para testes.

Para iniciar manualmente em terminais separados, com a central já em execução:

```powershell
node scripts/webhook-gateway.mjs
```

```powershell
./data/tools/cloudflared.exe tunnel --url http://127.0.0.1:3002 --no-autoupdate --protocol http2
```

Para encerrar processos iniciados manualmente, use Ctrl+C em cada terminal. Na sessão criada pelo assistente, consulte os PIDs em `data/tunnel-state.json` e confirme que pertencem a `cloudflared.exe` e `node scripts/webhook-gateway.mjs` antes de encerrá-los. Encerrar o túnel não encerra a central na porta 3000.

O callback do Instagram usa o domínio temporário seguido do caminho mostrado na configuração da conta. O painel local continua exibindo sua própria origem local; substitua a origem pelo domínio registrado em `data/tunnel-state.json` ao configurar a Meta. Não abra o domínio temporário esperando ver o painel: a raiz retorna 404 por projeto.

- [Cloudflare: Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

## Páginas de privacidade

As páginas públicas `/privacidade` e `/exclusao-de-dados` usam o nome comercial Acquarella e o WhatsApp empresarial informado para contato. Elas descrevem a operação atual, inclusive eventos brutos, encaminhamento ao WhatsApp, fornecedores de infraestrutura e ausência de exclusão automática. A solicitação de exclusão é manual, pela equipe; o link não é um callback automatizado de exclusão.

Ao cadastrar na Meta, use `/privacidade` no campo de política e `/exclusao-de-dados` na opção **URL de instruções de exclusão de dados**. Antes de ampliar a operação, complete a identificação da empresa e revise os critérios de retenção e as práticas reais com o responsável pelo tratamento dos dados. Um endereço temporário não substitui a disponibilidade contínua dessas informações: ao trocar o túnel ou migrar para hospedagem permanente, atualize os links na Meta.

Referência para os direitos dos titulares: [ANPD](https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados-1/direito-dos-titulares).

## Referências oficiais da Meta

- [Meta: contexto de resposta no WhatsApp](https://www.postman.com/meta/whatsapp-business-platform/request/73yi2uj/send-reply-to-text-message)
- [Meta: Instagram Send API](https://www.postman.com/meta/instagram/folder/uxudqu0/send-api)
- [Meta: Messenger Send API e janela de atendimento](https://www.postman.com/meta/messenger-platform-api/folder/vilwbh4/send-api)
