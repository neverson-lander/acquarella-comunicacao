# Conector CashBarber

A central consulta e registra agendamentos pelas APIs do CashBarber. O navegador é utilizado somente para conectar a conta e capturar a sessão. As operações internas continuam autenticadas por HMAC, isoladas por empresa e sem porta pública na VPS.

Em **CRM → Atendimentos por campanha → Consultar em massa**, o lote usa os filtros atuais e preserva atendimentos com qualquer confirmação de encerramento (Sim ou Não), reserva integrada confirmada ou pendente, conversão de agendamento ou resultado já encontrado. WhatsApp usa o telefone do atendimento; Instagram usa telefone/e-mail do cadastro da central. O conector confirma a correspondência exata com o cadastro externo e não escolhe por nome. Cadastros duplicados ficam para conferência. A busca por e-mail usa `POST /clientes/list` com `globalFilter`, pois a busca rápida não pesquisa e-mails. O período cobre até 93 dias de datas marcadas para serviço; continua valendo a comparação pela data de criação da reserva após a entrada pela campanha. A tela processa um registro por vez, permite parar/retomar e pausa em falhas de conexão, com renovação de sessão para os perfis autorizados. Mantenha a tela aberta durante o lote. Resultados são persistidos em `cashbarber_campaign_checks`, isolados por empresa e atendimento. Os valores de cada serviço vêm de `ags_valor`, congelados em centavos, incluindo zero. Valores ausentes permanecem desconhecidos; catálogo e preço atual não são usados para estimá-los. Agendamentos encontrados aparecem nos resultados da campanha e no CSV; não geram venda nem receita recebida.

No encerramento sem reservas feitas pela central, o atendente pode escolher **Selecionar agendamento existente no CashBarber**, buscar o cliente e consultar uma data. A ação interna `appointments` consulta `POST /agendamentos/list` na filial autenticada e retorna somente as reservas daquele cliente, com horário, profissional e serviços. A seleção é consultada novamente no encerramento e seu ID externo fica no histórico; nenhuma reserva é criada. O preenchimento manual continua disponível. Publique a central e o conector juntos para disponibilizar essa opção.

Em **CRM → Atendimentos por campanha → Consultar CashBarber**, a ação `campaign-bookings` consulta a agenda pela API e lê `GET /agendamentos/{id}` para obter `created_at`. A referência é a entrada do contato pela campanha atribuída, resolvida no servidor; não é a data de envio da mensagem à equipe. Funciona para atendimentos abertos, encerrados manualmente e encerrados em massa, sem exigir assumir ou reabrir. O cliente já vinculado é sugerido; também é possível buscar e selecionar o cadastro correto, sem modificar o vínculo. A consulta cobre até 93 dias de **datas marcadas para serviço**, incluindo datas futuras. Dentro desse intervalo, somente reservas criadas depois da entrada pela campanha e até o momento da consulta são consideradas. Canceladas são excluídas; não há dedução pela data do serviço ou de atualização. Campos ausentes e consultas incompletas são apresentados como inconclusivos. O limite é de 40 leituras de detalhes, com no máximo quatro simultâneas. Resultados ficam na sessão da tela e entram no CSV, separados da confirmação informada no encerramento; não alteram os indicadores de encerramento ou criam conversões. O cruzamento temporal não prova causalidade da campanha. Não há navegação por telas para essas consultas.

## Conexão

Em **Configurações → Minha conta CashBarber → Conectar / renovar sessão**, cada operador informa sua própria conta autorizada. As sessões das telas são isoladas por empresa e usuário da central, mantendo a autoria das operações no CashBarber. O campo **ID da filial** permite selecionar a filial, por exemplo 3782. Sem esse campo, o conector utiliza CASHBARBER_BRANCH_ID, a filial selecionada no painel durante o login ou a única filial retornada pela API. Contas com várias filiais exigem uma seleção explícita quando nenhuma estiver definida.

Token Bearer, cookies e estado do navegador são armazenados com AES-256-GCM no volume cashbarber-data, isolados por empresa e operador. A senha dos operadores é transitória. Sessões antigas compartilhadas por empresa não são herdadas por operadores. Cada operador precisa conectar sua conta após esta atualização. As consultas de encerramento, campanhas e CRM usam essa mesma sessão pessoal.

A conexão em **Mensagens da agenda → Conectar conta da automação** é separada. Somente ela guarda conta e senha criptografadas para renovar sessões expiradas, com espera de 15 minutos após falha. O conector limita esse contexto a status, conexão, desconexão e leitura da agenda das notificações. Ele nunca executa gravações no CashBarber. Desconectar uma sessão não afeta as demais. Os diários de operações continuam compartilhados por empresa para impedir duplicações, inclusive quando outro operador verifica uma tentativa anterior.

Não coloque credenciais nos arquivos de código, frontend ou Git. Preserve a chave e o volume juntos nos backups.

## APIs utilizadas

Todos os caminhos abaixo usam a base https://api.cashbarber.com.br/api/painel e a sessão capturada no login, com Authorization, Cookie e x-context: painel.

| Operação | Método e caminho |
| --- | --- |
| Catálogo ativo, com paginação | POST /servicos/list |
| Profissionais ativos e serviços habilitados | POST /usuarios/simpleListBarbeirosAtivos |
| Agenda, escala, intervalos e folgas | POST /agendamentos/list |
| Detalhes da reserva e data de criação | GET /agendamentos/{id} |
| Busca de cliente por termo | POST /clientes/simpleList |
| Base de clientes, com paginação | POST /clientes/list |
| Criar cliente | POST /clientes |
| Cadastro do cliente | GET /clientes/{id} |
| Três últimos agendamentos | GET /clientes/historico-curto/{id}?quantity=3 |
| Preço por cliente, serviço, profissional e data | POST /clientes/servico/preco |
| Conferência de conflitos e restrições | POST /agendamentos/check |
| Criar agendamento | POST /agendamentos |

Serviços são cruzados pelo ID do catálogo com uss_id_servico dos profissionais. Duração e preço avulso usam a personalização profissional quando houver. Preço e criação recebem o ID do catálogo, nunca o ID da linha de vínculo user_servicos. A conferência de preço retorna o valor do cliente/plano; o preço exibido na lista é apenas referência avulsa.

A grade usa os IDs dos profissionais, sem relacionar colunas por nomes. Janelas livres são calculadas dentro das escalas retornadas em horarios, descontando agendamentos, intervalos e folgas, inclusive afastamentos que atravessam dias. Não ter escala significa não ter janela livre. Dados incompletos ou não reconhecidos não viram disponibilidade. A resposta semanal contém horários e categorias de ocupação, sem nomes ou telefones dos clientes dos eventos. Datas e horários seguem Brasília.

## Agendamento e recuperação

1. Assuma um atendimento aberto, busque o cliente, confira telefone, ID, plano e histórico e vincule o cadastro.
2. Consulte a grade semanal, escolha profissional, serviço, data e início e consulte horário e preço.
3. Confira o resumo e confirme. A conferência vale cinco minutos e pertence ao operador, atendimento e cliente vinculados.
4. Ao confirmar, o conector relê catálogo, habilitação, preço e agenda, e consulta conflitos. Alterações no resumo ou restrições do fornecedor rejeitam a tentativa antes do envio.
5. Antes do POST de criação, o diário criptografado registra a intenção e os IDs existentes. O POST é enviado uma única vez. Depois, a agenda é consultada para localizar um novo ID por cliente, profissional, serviço, início e término.

Repetir a mesma operação nunca reenvia o POST, inclusive após reinício. Se o envio perder a resposta ou a confirmação for ambígua, a tentativa fica sem confirmação e bloqueia novas conferências nesse atendimento. Após dois minutos, **Verificar registro** consulta somente a agenda, sem gravar. Tentativas antigas da integração por telas exigem conferência manual. Se a conferência manual comprovar que o registro não existe, **Permitir nova tentativa** registra a declaração do operador sem apagar o diário anterior. Não elimine os diários para tentar novamente.

Não há garantia de exclusão mútua contra operadores externos: existe uma janela entre a última consulta e a criação, sujeita às validações do CashBarber. O cadastro novo pode ser feito pela central no painel de agendamento: busque o cliente, clique em **Cadastrar novo cliente no CashBarber**, preencha nome, telefone, e-mail, nascimento, origem e senha provisória exigidos pelo fornecedor. A central confere duplicidades por telefone/e-mail, envia o cadastro uma única vez e relê o resultado. Em perda de resposta, **Verificar cadastro** consulta a tentativa, inclusive após reinício, sem repetir o POST. A senha é transitória e não entra nos diários nem no cadastro da central. Após conferir os dados, clique em **Vincular este cliente** para continuar o agendamento. Alteração e exclusão de agendamentos também estão disponíveis na central; edição de clientes e cobrança continuam no painel CashBarber. A central agenda um serviço por vez e apresenta os três últimos registros do cliente.

## Cache e acesso

Cache em memória isolado por empresa e limitado a 200 entradas: status 15 s, catálogo/profissionais/serviços 2 min, cliente/busca 15 s, dia da agenda 30 s. Atualização explícita, login, desconexão e tentativa de gravação invalidam o cache. A confirmação sempre relê os dados. A grade semanal carrega sete dias progressivamente e permite filtrar profissional e mostrar bloqueios.

Visualizadores consultam. Vincular e agendar exigem atendimento aberto e assumido, respeitando as permissões do canal. Token, cookies e campos sensíveis do cadastro externo nunca são retornados à interface. A reserva externa não cria automaticamente venda ou conversão no CRM. O encerramento utiliza o preço histórico confirmado da reserva.

## Instalação e validação

Compose: deploy/vps/compose.yaml, serviço cashbarber. Configure CASHBARBER_SECRET com pelo menos 32 caracteres, igual ao valor de app.env, e CASHBARBER_STORAGE_KEY com 32 bytes aleatórios em base64. A URL interna é http://cashbarber:3200. CASHBARBER_BRANCH_ID é opcional. Preserve a chave e o volume juntos; o backup existente inclui sessões, credenciais de API e diários criptografados.

Execute as migrações existentes antes de recriar a aplicação e o conector. Esta troca de transporte não adiciona migração de banco. Implantação requer atualizar ambos os serviços, pois o formulário envia o ID do serviço.

Testes: node --test cashbarber-bridge/tests/*.test.mjs; em vercel-app, node --test tests/cashbarber.test.mjs; na raiz, node tests/ui/cashbarber-qa.cjs. Os testes de gravação e interface usam dados fictícios e APIs simuladas. A validação real é somente de leitura.

## Importar clientes para a central

Administradores encontram **Cadastro de contatos → Importar CashBarber**. Selecione o canal de destino; a importação lê páginas de 100 clientes da conta conectada. A tela apresenta o progresso e permite retomar após falhas. Repetir a importação preserva o vínculo por ID externo e identifica novos vínculos por telefone normalizado dentro do canal, incluindo a equivalência brasileira com/sem nono dígito. Telefones compartilhados podem ter mais de um ID externo vinculado ao mesmo contato; isso não escolhe automaticamente um cliente para agendamento. Nomes manuais, tags, observações, status e preferência de campanhas existentes são preservados; e-mail é preenchido apenas se estiver vazio. Novos contatos recebem campanhas por padrão; o status inativo do cadastro externo é preservado nos novos contatos. Registros sem nome ou telefone válido são contados como ignorados. Nenhuma mensagem é enviada pela importação. A tabela `cashbarber_contact_links` mantém os vínculos por empresa e canal.

## Alterar ou excluir agendamentos

No painel Agenda CashBarber, vincule o cliente e use **Agendamentos do cliente → Consultar agenda**, selecionando a data marcada para o serviço. A consulta inclui reservas criadas diretamente no CashBarber. Alterar permite escolher profissional, data, início e de um a dez serviços; confira o resumo anterior/novo e confirme a operação. A exclusão exige conferir o registro e marcar a confirmação. As gravações usam `PUT /agendamentos/{id}` ou `DELETE /agendamentos/{id}`, sem cancelar/recriar a reserva para alterar. Preço e disponibilidade são relidos, descontando o próprio agendamento da ocupação. Agendamentos finalizados, com falta registrada ou com comanda aberta são recusados. O fornecedor também aplica suas restrições.

A central mantém a versão original imutável e o diário `cashbarber_changes`. Alterações confirmadas geram nova versão local; reservas excluídas deixam os totais atuais. Confirmações de encerramentos anteriores são preservadas. Consultas de campanha afetadas ficam inconclusivas até nova consulta. Resultados incertos bloqueiam novo agendamento e encerramento no atendimento; use **Verificar resultado**, inclusive após recarregar a tela. O diário criptografado do conector evita repetir PUT/DELETE após timeout ou reinício. Testes de escrita usam APIs fictícias; a validação real é somente leitura.

O painel também lista automaticamente as próximas 30 reservas do cliente nos próximos 90 dias, com consulta em cache por até 30 segundos e invalidação após gravações. Clique na reserva para abrir as opções. A consulta por data permanece disponível. Na alteração, os horários livres calculados para todos os serviços selecionados aparecem como botões; selecionar outro início refaz a conferência sem gravar. Datas apresentadas em DD/MM/AAAA; valores enviados à API continuam em ISO. Exclusão sem corpo não envia Content-Type JSON; respostas 204 preservam cookies de sessão renovados antes da verificação do resultado.
