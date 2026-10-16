# Acquarella — produção na Vercel e Supabase

O código desta pasta também é usado na instalação independente atual na VPS. Para operar ou publicar nessa instalação, siga [deploy/vps/README.md](../deploy/vps/README.md). As instruções abaixo descrevem a alternativa Vercel/Supabase e não devem ser usadas para atualizar a VPS.

Aplicação: https://acquarella-comunicacao.vercel.app

O projeto Vercel `acquarella-comunicacao`, equipe `acquarella`, usa PostgreSQL gerenciado pelo Supabase. O administrador, as contas e o histórico inicial foram migrados da central local. O e-mail e a senha existentes continuam válidos; sessões antigas não foram transferidas.

## Publicar alterações

Execute a partir desta pasta:

```powershell
node --test tests/*.test.mjs
node node_modules/vercel/dist/index.js deploy --prod --yes
```

O build executa `scripts/migrate.mjs`: aplica somente migrações pendentes, verifica a criptografia das credenciais, RLS e a leitura autenticada do painel. Uma sessão temporária de teste é excluída ao terminar. Nunca use o banco de produção para testes destrutivos.

As variáveis `POSTGRES_URL` e demais credenciais Supabase são gerenciadas pela integração da Vercel. `APP_ENCRYPTION_KEY` preserva a chave da central existente. `POSTGRES_CA` contém a CA oficial do Supabase, mantendo a verificação TLS ativa. Não substitua a chave de criptografia sem recriptografar os registros. A variável temporária `ACQUARELLA_MIGRATION_DATA` só foi necessária à importação inicial e deve permanecer removida depois dela.

Datas bigint são convertidas com segurança para números JavaScript, permissões usam JSONB e o login aceita tanto os hashes scrypt migrados quanto os novos PBKDF2. O limite de tentativas de login é compartilhado no PostgreSQL. As tabelas usam RLS sem políticas públicas; o backend aplica isolamento por empresa e permissões por conta.

## Documentação de ajuda

### Feedback durante ações

As ações de login, saída, atualização, atendimento, envio, salvamento e consultas à Meta mostram um indicador no botão e um aviso de execução. O estado permanece até o fim da ação e da atualização dos dados, com bloqueio de envios repetidos e restauração dos controles em caso de falha. Formulários não podem ser fechados durante o salvamento. A sincronização automática aguarda as ações em execução e não aciona avisos de loading. O CSS respeita a preferência de movimento reduzido.

Validação de navegador com APIs simuladas lentas, falhas e novas tentativas: `node tests/ui/loading-qa.cjs`, executado a partir da raiz do workspace, com Playwright instalado. Não usa dados nem credenciais de produção. Para conferir os arquivos publicados e a proteção de acesso anônimo, execute `node scripts/verify-loading-production.mjs` na raiz.

O menu **Ajuda e manual** está disponível a todos os perfis, com busca no texto dos capítulos. O formulário de canais possui **Ajuda para configurar este canal**, que abre o roteiro correspondente. O manual completo em `/manual.html` também pode ser aberto sem login e impresso ou salvo como PDF pelo navegador; contém somente documentação pública, sem credenciais ou dados da empresa.

O conteúdo é mantido em `public/manual.html`, fonte única tanto da ajuda integrada quanto da versão para impressão. `public/help.js` carrega os capítulos e implementa a busca, e `public/help.css` define a leitura responsiva e a impressão. Ao mudar campos ou regras da aplicação, revise os capítulos e a data de revisão. A documentação descreve esta versão Vercel; as versões local SQLite e do artefato antigo em `production-site` têm escopos diferentes.

Inclui pré-requisitos, configuração de Instagram Login, Messenger e WhatsApp Cloud API, testes de recebimento/resposta, ponte da equipe, todas as telas do painel, CRM, métricas, permissões, soluções de problemas e limites da versão. As instruções não substituem as etapas de aprovação e configuração no painel Meta.

## CRM, Serviços e Atendimento

### Área de atendimento e avisos

A Caixa de entrada ocupa a altura disponível da janela, com menu lateral e resumos recolhíveis, abas compactas Fila/Meus atendimentos/Todos, modo Só conversa, tempo de espera e destaque de mensagens novas. Menu e resumos conservam a preferência por usuário/empresa neste navegador. No celular, a lista e a conversa são telas alternadas com botão de retorno. Os detalhes de canal/origem ficam em um painel expansível. **Modo conversa** recolhe toda a área superior e compacta o compositor, mantendo uma barra curta com o cliente, acesso à fila, menu ⋯ e encerramento. Transferência, histórico, CRM, identificação, avisos e atualização continuam disponíveis no menu; o ícone Mostrar controles de atendimento restaura a visão completa. A preferência é guardada por usuário/empresa, sem prender a navegação quando não há conversa selecionada.

O polling autorizado de estado e CRM ocorre a cada 5 segundos com a central aberta, inclusive durante a digitação, com modal aberto ou em outras telas. Avisos na aplicação anunciam novas mensagens da fila e respostas nos próprios casos abertos. A primeira carga estabelece a referência sem anunciar histórico; IDs evitam repetição e o horário inicial da consulta retornado por `/api/state` distingue contatos novos de casos históricos que passaram a ficar visíveis. Não há Web Push/service worker nem avisos com o navegador fechado; abas em segundo plano podem sofrer limitação de timers. Os avisos não exibem o texto da mensagem e respeitam os dados autorizados pelo servidor.

Atualizações preservam rascunho, cursor e posição do histórico; rascunhos são mantidos somente na memória desta sessão e descartados ao sair/recarregar. Ctrl/Command + Enter envia; Enter insere nova linha. A fila prioriza a mensagem pendente mais antiga, ignorando respostas falhas/simuladas no cálculo de espera. Os demais grupos priorizam mensagens novas. A área de leitura oferece Novas mensagens ↓ quando há chegada enquanto o usuário lê o histórico. Falhas de sincronização ficam visíveis na barra, sem limpar a tela existente.

### Tela de métricas

O menu **Métricas** reúne a fila e os atendimentos abertos atuais, conversas sem resposta enviada há 30 minutos, novos contatos, encerramentos, reaberturas, respostas confirmadas/falhas, medianas da primeira resposta e do tempo entre assunção e encerramento, agendamentos informados no encerramento, eventos de agendamento/atendimento/venda no CRM, receita e ticket médio. Inclui movimento diário, produtividade por autor, canais, campanhas e serviços selecionados no encerramento, com exportação CSV. O período inicial é de 30 dias e pode ser alterado ou ampliado para todo o histórico. Datas usam Brasília; filtros de canal e responsável atual respeitam as permissões existentes.

Fila e abertos são o retrato atual independente das datas. As atividades são contadas por data de ocorrência, incluindo conversas antigas. Os resultados de aquisição consideram novos contatos do período e conversões acumuladas até agora, por primeiro contato; oportunidades com várias vendas contam uma vez na taxa de conversão. Agendamento confirmado no encerramento e evento de agendamento no CRM são medidas separadas. A taxa de agendamento do SAC exclui encerramentos históricos sem confirmação. Tempos sem evidências completas ficam indisponíveis; não há autoria presumida para mensagens antigas. O tempo em atendimento cobre o ciclo desde a assunção, incluindo transferências, e recebe o autor do encerramento. Conta demonstrativa, conversa `demo-*`, evento cancelado e evento futuro não entram nas atividades realizadas. Não há cálculo de ROAS ou gasto em anúncios.

O histórico completo de atendimento é retornado pelo CRM apenas para oportunidades que o usuário já pode visualizar, evitando o limite de 50 registros do histórico exibido no SAC nos cálculos de produtividade.

O menu **CRM e vendas** reúne Funil, Contatos, Indicadores e, para administradores, Serviços, Tags e Marketing. Serviços têm nome, descrição, preço em centavos de BRL e arquivamento. O preço do cadastro não altera vendas já registradas. Tags e serviços pertencem à empresa. Uma oportunidade nasce por conversa; contatos de canais diferentes só são vinculados por confirmação manual, nunca por semelhança de nome.

O funil inicial contém Novo contato, Qualificado, Proposta, Agendado, Atendimento realizado, Venda e Perdido. A perda exige motivo; oportunidades também têm oferta, notas e próximo retorno. Mover um cartão não cria uma conversão financeira. Agendamento, atendimento e venda são eventos separados, com data, operador autenticado e valor efetivo da venda. Eventos usam identificadores idempotentes; cancelamentos preservam o registro e o histórico. A agenda é um registro no CRM, não um calendário externo integrado.

A caixa de entrada separa **Fila de atendimento** (casos abertos sem responsável) e **Meus atendimentos** (abertos ou finalizados). A retirada da fila usa bloqueio transacional: duas pessoas não assumem o mesmo caso. O servidor restringe conversas e CRM aos canais permitidos e, para atendentes/visualizadores, à fila e aos próprios casos. Administradores e recepcionistas podem acompanhar todos os casos dos canais aos quais têm acesso, transferir, reabrir e devolver à fila. O administrador configura o perfil Recepcionista em Equipe e permissões. O histórico registra origem, destino, autor e horário da transferência. O responsável no CRM acompanha a atribuição do SAC; o crédito de uma conversão continua sendo de quem a registrou.

Novos contatos entram sem responsável na fila, que é a visão inicial do SAC. Todos os perfis, inclusive administrador e recepcionista, precisam assumir antes de responder a um caso da fila. Casos finalizados exigem reabertura para responder. Não existe atribuição automática ao enviar uma resposta. Quando uma nova mensagem chega após o encerramento, a conversa e o responsável no CRM são devolvidos à fila sem atendente; o histórico e as conversões anteriores são preservados. Mensagens durante um atendimento aberto mantêm o responsável. Entregas duplicadas não desfazem uma nova atribuição.

O encerramento exige confirmação de origem (Orgânico ou Campanha paga). Para campanha paga, o seletor de anúncio fica obrigatório e aceita somente IDs já cadastrados na mesma empresa em CRM > Marketing. Atendentes podem consultar esse catálogo, mas somente o administrador pode alterá-lo. Encerramento e registro da origem são transacionais e auditados; erros deixam o caso aberto. Uma nova reabertura exige nova confirmação ao encerrar. A confirmação corrige a atribuição inicial sem apagar evidências anteriores; conversões já registradas mantêm sua atribuição congelada.

Também é obrigatório responder **Houve agendamento de serviços?**, sem resposta pré-selecionada. **Sim** exige selecionar um ou mais serviços ativos em CRM > Serviços; **Não** encerra sem serviços selecionados. O servidor valida a resposta e o catálogo da empresa na mesma transação do encerramento. O histórico guarda a resposta e os IDs e nomes dos serviços na data do registro, preservando-os após renomeação ou arquivamento. Reabrir exige uma nova confirmação, sem apagar encerramentos anteriores. Registros antigos permanecem sem informação de agendamento. Essa confirmação não cria eventos de conversão nem datas de agenda automaticamente; esses registros continuam no CRM.

Novos webhooks preservam `referral`, `source_id`/`ad_id`, `source_type`, contexto do anúncio e `ctwa_clid` quando fornecidos pela Meta. Referências separadas da mensagem são guardadas até a conversa existir. Sem evidência, a origem é **Não identificada**, não automaticamente orgânica. `source_type=post` identifica referência orgânica; anúncio e click ID indicam pago. As conversas anteriores à implantação mantêm origem desconhecida; não há atribuição retroativa inventada. Uma origem pode ser acrescentada ou corrigida manualmente com evidência, sem apagar os webhooks.

O webhook normalmente não traz o nome da campanha nem do conjunto. Com uma credencial Meta Ads com `ads_read` e acesso à conta de anúncios em Marketing, novas referências consultam automaticamente campanha, conjunto, anúncio e criativo (ID, nome, título/texto, vídeo e prévia quando disponíveis). O anúncio identificado é cadastrado automaticamente. Consultas usam cache de 6 horas e limite de 4 segundos; uma recusa da Meta não impede a entrada do lead. **Atualizar identificados** consulta até 10 cadastros pendentes por execução; **Consultar Meta** atualiza um anúncio específico. A credencial é criptografada separadamente e nunca retornada ao navegador. Salvar o token não comprova sua validade; recusas da Meta aparecem no cadastro. Nenhuma permissão de Marketing é concedida automaticamente. Serviços/ofertas mapeados são aplicados a novas referências de anúncio, sem sobrescrever interesses já preenchidos.

Cada referência preserva a primeira fotografia de metadados consultados e seu horário. Dados consultados posteriormente à entrada não comprovam qual versão antiga foi exibida. Criativos dinâmicos podem conter várias imagens/vídeos: a interface identifica o criativo associado, mas não inventa a variante exibida. Sem referência Meta, não é possível atribuir automaticamente um contato a um anúncio. Referências só com click ID, sem ad ID, permanecem pagas com anúncio não identificado. Mídia recebida no webhook tem preferência sobre a prévia genérica consultada. URLs de mídia são limitadas a HTTPS da Meta e podem expirar. O webhook Instagram assina também `messaging_referral` para capturar referências separadas de mensagens.

Indicadores usam coortes pela data do primeiro contato, somente contas reais, com filtros de canal, responsável, serviço, tag, estágio e origem. Comparam campanha, conjunto, anúncio, criativo ou origem: oportunidades, qualificação atual, agendamentos, atendimentos, oportunidades com venda, clientes distintos, receita e mediana do tempo até a primeira venda. Uma oportunidade com várias vendas conta uma vez na taxa de conversão; a receita soma todas as vendas válidas. Conversões canceladas ficam fora. O modelo Primeiro contato preserva a origem inicial (ou sua correção explícita); Último pago até a primeira venda usa a evidência congelada ao registrar a primeira venda válida. As conversões guardam ambas as evidências para auditoria. Campanhas posteriores não reatribuem a aquisição de uma venda anterior.

O relatório da equipe distingue oportunidades sob responsabilidade atual de conversões registradas pelo operador. Respostas falhas/simuladas não contam como enviadas. A mediana de primeira resposta só é calculada se a primeira resposta enviada tiver operador identificado; registros históricos sem identificação não ganham autoria fictícia. Exportação CSV inclui a coorte selecionada e neutraliza fórmulas em campos de texto. Não são calculados CPL/ROAS nem enviados eventos à Conversions API: gasto publicitário e retorno de conversões à Meta não fazem parte desta integração.

Os testes `crm-attendance.test.mjs` usam PostgreSQL isolado em memória via PGlite, incluindo migrações, RLS, isolamento por empresa/operador, concorrência de retirada, transferência, dinheiro, deduplicação e relatórios. Eles não escrevem registros de teste em produção.

- [Meta: referência Click-to-WhatsApp recebida no webhook](https://www.postman.com/meta/whatsapp-business-platform/request/g7sv9jo/received-message-triggered-by-click-to-whatsapp-ads)
- [Meta: Marketing API](https://www.postman.com/meta/facebook-marketing-api/overview)

### Configuração dos Canais

As credenciais de Instagram e Messenger estão criptografadas no banco. As URLs públicas de webhook aparecem em Canais de comunicação. A aprovação/validade das credenciais na Meta e a atualização do callback na Meta são independentes da hospedagem. A verificação automatizada dos endpoints não envia mensagens a clientes.

A central recebe mensagens de Instagram, Messenger e do número conectado à WhatsApp Cloud API. A aba WhatsApp reúne conversas diretas; o nome do contato vem do webhook, e nas redes sociais a central consulta o perfil quando disponível. A identificação pode ser editada no painel. Respostas pelo app recebem a assinatura do operador autenticado. No WhatsApp, imagens e figurinhas recebidas aparecem na conversa, áudios têm player e download, e reações do cliente aparecem junto à mensagem correspondente. O acesso aos anexos exige login e permissão para a conversa; arquivos antigos dependem da disponibilidade na Meta. Vídeos, documentos e anexos de outros canais continuam como aviso ou legenda. O envio pelo painel continua sendo de texto.

Cada conta possui uma opção de encaminhamento ao WhatsApp da equipe. Desativá-la mantém o atendimento somente pelo app, cancela encaminhamentos pendentes e bloqueia o retorno de respostas citadas pela ponte. Ativá-la não reenvia mensagens antigas. Respostas pelo telefone compartilhado são identificadas como "Equipe WhatsApp", sem atribuição individual fictícia.

Em 30/09/2026, a produção usa o número de teste da Meta +1 555-193-9562 (Phone Number ID 1432099399978034), com destino da equipe +55 34 98874-8139. A comparação do remetente aceita a identificação brasileira sem o nono dígito devolvida pela Meta. Um teste real confirmou Instagram -> central -> WhatsApp da equipe -> Instagram, com a resposta citada "recebi" registrada como enviada. O encaminhamento depende da janela de atendimento de 24 horas, renovada ao receber uma mensagem da equipe; o diagnóstico autenticado mostra se ela está aberta e até quando. As mensagens do WhatsApp comum da equipe não são importadas automaticamente: para atender clientes no número comercial, ele precisa ser conectado à API.

Com autorização do responsável, foi criado o usuário do sistema Acquarella (61594749729800), perfil Employee, com acesso parcial ao aplicativo da central e à conta WhatsApp de teste (mensagens e visualização de números). O token temporário foi substituído por um token de 60 dias com os escopos whatsapp_business_management e whatsapp_business_messaging, salvo criptografado e validado na produção. Um segundo teste após a troca confirmou o encaminhamento de "Teste final credencial" e o retorno de "recebido novamente" ao Instagram. Renove-o antes de expirar. O número de teste não representa um cadastro comercial concluído.

Em Canais de comunicação > Configurar conta > Verificar conexão, administradores podem verificar o token salvo no servidor sem expor credenciais. O diagnóstico do Messenger confirmou token válido e assinatura de mensagens ativa. Um teste real confirmou o recebimento na central e a resposta entregue no Messenger. Isso comprova o fluxo para a conta de teste, não a liberação geral para o público. A análise de `pages_messaging` e `pages_manage_metadata` foi iniciada na Meta, mas não enviada; a liberação para o público ainda depende dos requisitos e aprovação da plataforma. A verificação como pessoa física está pendente de dados fiscais exigidos pela Meta.

Os scripts da pasta raiz que usam `data/central.sqlite` verificam uma cópia local antiga. Suas credenciais podem diferir das atuais em produção. Não use essa cópia para sobrescrever as contas publicadas.

O script abaixo verifica HTTP, privacidade, autenticação obrigatória e assinaturas de webhook usando as credenciais da cópia SQLite local. Execute-o somente se essa cópia tiver os mesmos App Secrets de produção; credenciais antigas causam 403 no teste de assinatura e não comprovam falha da integração publicada:

```powershell
node scripts/verify-vercel-production.mjs
```

O serviço publicado funciona sem depender do servidor local ou do Quick Tunnel. Esses processos locais não são desligados pela publicação.

### Alertas de espera no WhatsApp

Cada canal possui `alerts_enabled`, `queue_alert_minutes` e `assigned_alert_minutes` (1–1440, padrão 15, desativado inicialmente). O intervalo define a espera mínima e a repetição por categoria. São considerados apenas casos abertos com mensagens recebidas após a última resposta enviada com sucesso. O alerta inclui cliente, espera e atendente, quando atribuída; exclui o próprio telefone da equipe. Independe de `forwarding_enabled`.

O build configura Supabase pg_cron + pg_net a cada minuto; CRON_SECRET deve estar na Vercel e fica no Supabase Vault. `/api/internal/waiting-alerts` exige Bearer e `?status=1` verifica o agendador e a última resposta HTTP. A tabela de requisições tem RLS e retenção de sete dias. A janela WhatsApp de 24 horas continua obrigatória; falhas são registradas em jobs/Atividade. Claims transacionais e intervalos persistidos impedem duplicação entre execuções concorrentes. Cada canal tem uma lista independente `alerts_phones` de até 20 telefones, normalizados e deduplicados (incluindo o formato brasileiro legado). A migração preserva o telefone da equipe como destino inicial dos canais existentes. Cada destinatário tem sua própria janela de 24 horas e job persistente. A fila de respostas/encaminhamentos não consome jobs de alertas. Até seis entregas são processadas por execução, com três envios paralelos; destinatários restantes seguem nas próximas verificações sem perda ou duplicação. Antes de enviar, o worker revalida o canal, destinatário, remetente e espera atual, cancelando alertas removidos, desativados ou já atendidos. Webhooks registram janelas individuais; mensagens de contatos cadastrados para alertas renovam a janela, sem criar casos no SAC ou conceder acesso à ponte. Atividade identifica canal e destinatário. Entregas interrompidas são marcadas incertas e não reenviadas imediatamente.

## Respostas e anexos (15/10/2026)

O editor permite emojis, seleção de um anexo por envio e gravação de áudio de até três minutos, com prévia e remoção. Texto e anexo são mensagens separadas. Instagram aceita imagens JPG/PNG, áudio, vídeo MP4/MOV e PDF; Messenger e WhatsApp têm formatos e limites próprios, mostrados no editor. Arquivos enviados ficam criptografados em reply_attachments/reply_attachment_parts, com upload em partes de 1 MB e acesso autenticado por atendimento. A Meta recebe um link assinado por até 15 minutos para a entrega.

Imagens, áudio, vídeo e documentos recebidos são preservados a partir dos webhooks. O histórico usa uma rota autenticada para visualizar ou baixar, com suporte a ranges, PDFs em outra aba, múltiplos anexos e renovação de URLs quando a API da Meta disponibiliza. Links externos são restritos aos domínios de mídia da Meta; tokens não são encaminhados aos CDNs. Mídias temporárias ou expiradas podem exigir novo envio pelo cliente. A migração 202610150013_inbound_media recupera os metadados ainda disponíveis nos eventos antigos, sem criar novas mensagens ou envios.

Validação: node --test tests/*.test.mjs em vercel-app; testes de interface tests/ui/reply-attachments-qa.cjs e tests/ui/loading-qa.cjs na raiz, com PLAYWRIGHT_MODULE apontando para Playwright. Em produção foram aceitos imagem, áudio WAV, vídeo MP4 e PDF para a conversa de teste do administrador.

## WhatsApp por QR Code

O canal WhatsApp aceita API oficial da Meta ou QR Code por aparelho vinculado. Em Canais de comunicação, escolha a forma de conexão ao adicionar o canal. Canais existentes permanecem oficiais. O modo QR requer o serviço persistente de [whatsapp-qr-gateway](../whatsapp-qr-gateway/README.md), com sessão criptografada, callback assinado e variáveis WHATSAPP_QR_URL/WHATSAPP_QR_SECRET no backend. A fila, atribuição, histórico, CRM, anexos e permissões são compartilhados. Nenhuma nova migração SQL é necessária. Testes não substituem o pareamento real e a validação do número após a implantação.
