# WhatsApp por QR Code na Acquarella Central

O painel mantém os canais oficiais e acrescenta **WhatsApp → QR Code · aparelho vinculado**. O número é vinculado pelo celular; não precisa de token Meta nem Phone Number ID. A implementação usa a biblioteca Baileys, independente da Digisac. Não é a API oficial da Meta, pode exigir manutenção quando o protocolo muda e a conta continua sujeita às restrições do WhatsApp.

## Arquitetura

`Painel → backend Vercel → serviço QR persistente → WhatsApp`

`WhatsApp → serviço QR → callback assinado na central → histórico, fila e CRM existentes`

O serviço mantém a conexão WebSocket e as chaves de pareamento em SQLite criptografado. Precisa de um processo Node 24 continuamente ativo e volume persistente. Não deve ser executado como uma Function com duração limitada. O painel e o PostgreSQL permanecem nos serviços existentes. Não há dependência da API Digisac.

## Colocar em operação

1. Escolha um servidor/container persistente e um endereço HTTPS para o serviço, por exemplo `https://whatsapp.seu-dominio.com`. O serviço deve conseguir acessar a central, o WhatsApp e os servidores de mídia. Configure o proxy HTTPS para `127.0.0.1:3100`; não exponha a porta diretamente sem TLS.
2. Copie `.env.example` para `.env` nesta pasta. Configure a origem HTTPS da central em `APP_ORIGIN`, um segredo aleatório de pelo menos 32 caracteres em `WHATSAPP_QR_SECRET` e uma chave **independente** de 32 bytes em base64 em `QR_STORAGE_KEY`. Use um gerenciador de segredos; não envie valores por chat nem os inclua no Git.
3. Na Vercel, no projeto existente, acrescente **somente no ambiente correto** `WHATSAPP_QR_URL` com a origem HTTPS do serviço e `WHATSAPP_QR_SECRET` com o mesmo segredo de comunicação. Mantenha `APP_ENCRYPTION_KEY`, banco e credenciais oficiais atuais. O segredo QR é exclusivo do servidor, nunca uma variável pública. Use valores separados para produção e testes.
4. Nesta pasta, execute `docker compose up -d --build`. O contexto de build é a raiz do repositório; ele inclui apenas o serviço e o módulo de assinatura compartilhado. Alternativamente, use Node 24: `pnpm install --frozen-lockfile`, depois `node --env-file=.env server.mjs`, sob um supervisor de processos com reinício automático.
5. Publique a central seguindo as instruções de `vercel-app/README.md`. Esta alteração não requer uma migração nova: o tipo de conexão fica nas credenciais já criptografadas de cada canal.
6. Entre como administrador: **Canais de comunicação → Adicionar canal → WhatsApp → QR Code · aparelho vinculado → Ativo → Salvar**. Depois abra **Conexão / QR Code** e clique em **Conectar / gerar QR Code**.
7. No celular: **WhatsApp → Aparelhos conectados → Conectar um aparelho**. Escaneie o QR exibido na central. O estado deve mudar para **Conectado**, com o número do aparelho.
8. Envie uma mensagem de um telefone de teste autorizado para o número conectado. Confirme sua entrada na fila, assuma o atendimento e responda. Verifique texto, imagem, áudio, documento e retorno após reiniciar o serviço. O pareamento real só pode ser validado após esse passo.

Ao pausar uma instância ou fazer manutenção, use a opção **Desconectar** no painel e confirme a lista de aparelhos no celular. Uma sessão encerrada pelo próprio WhatsApp exige novo pareamento. Não execute duas réplicas usando o mesmo volume/sessão. O processo limita a dez canais; aumente capacidade e supervisão antes de ampliar esse limite.

## Fluxos preservados e limites

- Canal oficial existente continua sendo Meta/Cloud API; canais antigos sem `transport` são tratados como oficiais. Um canal não troca de transporte no lugar: adicione outro para preservar seus identificadores e histórico.
- WhatsApp QR entra na mesma fila e usa as mesmas permissões, atribuição, assinatura do atendente, histórico, CRM e anexos do WhatsApp oficial.
- A janela de 24 horas continua obrigatória para as APIs oficiais. Esse bloqueio não é aplicado ao transporte QR, inclusive quando ele envia encaminhamentos/alertas; limites de cada rede social continuam aplicados ao destino original.
- Mensagens enviadas pelo celular após o pareamento são espelhadas como **WhatsApp vinculado**, sem atribuir um operador fictício, reabrir atendimentos resolvidos ou renovar uma janela de cliente. Grupos, status, transmissões, newsletters, chamadas e importação de histórico anterior não fazem parte deste canal.
- Texto, imagem, áudio, vídeo, documentos, figurinhas recebidas e reações do cliente são integrados. A interface mantém os formatos/limites de anexo já existentes. Conteúdo de visualização única permanece no celular. Anexos indisponíveis após três tentativas geram um aviso no histórico em vez de impedir a entrada da mensagem.
- O recebimento usa fila local persistente e callback HMAC com validade de um minuto; reenvios do mesmo evento não duplicam mensagens. Envios usam o ID do job para deduplicação. Se houver dúvida após timeout/reinício, o envio fica incerto e não é repetido automaticamente.
- O histórico permanece no PostgreSQL da central. No serviço QR, mídia, cópias técnicas e registros de deduplicação têm retenção de 30 dias; mídia recebida mais antiga pode ficar indisponível. Eventos ainda não entregues não são excluídos automaticamente. Monitore disco e callbacks recusados.
- As sessões são restauradas no reinício. QR Codes e chaves de sessão nunca são publicados em logs; o QR é disponibilizado apenas a administradores autenticados da empresa. A leitura de mídia passa pelas permissões de atendimento da central.
- Não há migração de conversas antigas da Digisac nem associação automática de uma sessão QR a uma conta oficial. As métricas de envio QR ficam na central, não na WhatsApp Business Platform.

## Operação e backups

Use `/health` para verificar o processo, a tela **Conexão / QR Code** para a sessão e a tabela `inbox` do serviço para eventos pendentes (sem expor seus corpos). Faça backup consistente do volume SQLite e guarde `QR_STORAGE_KEY` separadamente; sem a chave os dados não podem ser recuperados. Nunca altere essa chave sem uma migração de criptografia. Faça atualizações do Baileys primeiro em ambiente de teste. A chave HMAC pode ser rotacionada coordenadamente na central e no serviço, sem trocar a chave de armazenamento.

## Testes

Na pasta `vercel-app`: `node --test tests/*.test.mjs`. Nesta pasta: `node --test tests/*.test.mjs`. Os testes usam banco isolado e sockets/WhatsApp simulados; não enviam mensagens a pessoas nem validam o pareamento de um número real.

Referências: [Baileys](https://github.com/WhiskeySockets/Baileys), [exemplo oficial do socket](https://github.com/WhiskeySockets/Baileys/blob/master/Example/example.ts).

## Opção de hospedagem gerenciada: Railway

Configuração preparada em whatsapp-qr-gateway/railway.json. Em um serviço separado no mesmo repositório, mantenha a raiz de build no repositório e selecione esse arquivo como Config File Path. Crie um volume persistente em /app/whatsapp-qr-gateway/data, com QR_DATA_DIR nesse mesmo caminho. Configure uma única réplica, desative Serverless/App Sleeping e gere um domínio público HTTPS para o serviço. O /health verifica a execução; o pareamento é verificado na central.

A documentação da Railway informa que volumes são montados como root. Para esta imagem com usuário node, a opção documentada é RAILWAY_RUN_UID=0; caso use uma imagem ajustada por sua equipe, prefira preparar as permissões do volume e executar a aplicação sem privilégios. O volume deve ficar privado e somente este serviço deve acessá-lo.

Preços consultados em 15/10/2026: Hobby tem consumo mínimo de US$ 5/mês, com US$ 5 de crédito mensal; Pro tem mínimo de US$ 20/mês, com US$ 20 de crédito. O uso excedente é cobrado, portanto esses valores não representam um teto. O Pro é apresentado pelo provedor para equipes e aplicações profissionais. O custo efetivo deste canal só poderá ser medido depois de implantado. Nenhum plano foi contratado nesta etapa.

Fontes: https://railway.com/pricing ; https://docs.railway.com/volumes ; https://docs.railway.com/config-as-code/reference

## Testes neste computador Windows

Execute scripts/start-qr-local.ps1 na raiz do projeto. O iniciador usa Node 24, cria chaves de teste próprias, protege os arquivos de ambiente e inicia os processos em segundo plano. O painel fica em http://127.0.0.1:3187 e o serviço QR em http://127.0.0.1:3100. Ambos escutam somente no endereço local.

Na primeira abertura, crie seu administrador local. O banco PostgreSQL compatível PGlite é persistido em data/qr-local-central; sessões e mídias do gateway ficam em data/qr-local-gateway. Esses dados são separados da produção. Os arquivos privados .env.qr-local de cada componente precisam ser preservados junto aos respectivos dados. Não copie as chaves de produção.

Depois de entrar, adicione WhatsApp → QR Code · aparelho vinculado → Ativo, salve e abra Conexão / QR Code. Leia o QR pelo celular do número de teste. Para este teste local, painel e serviço estão no mesmo computador e não exigem túnel. Um painel publicado na Vercel não consegue acessar esse endereço 127.0.0.1.

Para encerrar, execute scripts/stop-qr-local.ps1. Para voltar, execute novamente o iniciador. O script verifica os PIDs e os caminhos dos processos antes de encerrá-los e preserva as sessões. O computador precisa permanecer ligado, sem suspensão, e conectado à internet durante os testes. Logs ficam em data/qr-local-runtime; não compartilhe os arquivos de ambiente nem o banco.
