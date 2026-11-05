# Instalação independente na VPS

Aplicação Node.js 24, PostgreSQL 17, conector WhatsApp por QR e Caddy para HTTPS. O código de produção é `vercel-app`, sem dependência de hospedagem Vercel ou de serviços Supabase. O modo Vercel continua disponível e mantém a validação TLS do PostgreSQL remoto.

## Instalação configurada

- Endereço: https://vps-0345876c.vps.ovh.ca/
- Servidor: 51.222.220.251, Ubuntu 26.04, usuário SSH `ubuntu`.
- Diretório: `/opt/acquarella`; Compose em `/opt/acquarella/deploy/vps`.
- Somente portas 22, 80 e 443 publicadas. PostgreSQL e gateway não têm portas publicadas; o banco está em rede Docker interna. HMAC continua obrigatório no gateway.
- Caddy recebe o alias do domínio público na rede Docker do WhatsApp. Assim os callbacks e downloads usam HTTPS com certificado válido diretamente na rede privada, sem herdar a resolução `127.0.1.1` que o hostname da OVH pode ter no host.
- Papel `acquarella` é dono do banco e das tabelas, sem superusuário, criação de bancos/papéis ou bypass global de RLS. A aplicação aplica a autorização dos usuários e empresas no servidor.
- Volumes nomeados preservam PostgreSQL, sessões WhatsApp e certificados. Os serviços reiniciam com Docker e com a VPS.
- Alertas executados no próprio processo da aplicação, a cada minuto; não usam Supabase Cron.

Arquivos `.env`, `app.env` e `gateway.env` são privados, com permissão 600 e excluídos do Git e do contexto Docker. Não imprimir `docker compose config`, apenas `docker compose config --quiet`, pois o comando completo mostra segredos.

O cadastro do primeiro administrador exige o link privado `/initial-setup/<INITIAL_SETUP_TOKEN>`. Ele cria um cookie seguro de uma hora e redireciona para a interface. Não existe cadastro público sem esse cookie; depois do primeiro usuário, o próprio banco/aplicação recusa nova configuração inicial. Remova `INITIAL_SETUP_TOKEN` de `app.env` após concluir o cadastro e recrie apenas o contêiner da aplicação. Nunca altere `APP_ENCRYPTION_KEY` ou `QR_STORAGE_KEY` após cadastrar contas/sessões.

## Operação

```sh
cd /opt/acquarella/deploy/vps
sudo docker compose ps
sudo docker compose logs --tail=50 app whatsapp-qr
sudo docker compose restart app whatsapp-qr
```

Para atualizar, preservar os arquivos privados e os volumes, copiar o código revisado e:

```sh
sudo docker compose build
sudo docker compose up -d --wait postgres
sudo docker compose run --rm --no-deps app node scripts/migrate-standalone.mjs
sudo docker compose up -d app whatsapp-qr cashbarber caddy
```

O migrador independente aplica somente SQL pendente, em transação e com trava. Ele não importa dados SQLite antigos e não altera inscrições ou webhooks na Meta. Não executar o `scripts/migrate.mjs` da Vercel nesta instalação.

## CashBarber

O serviço `cashbarber` utiliza APIs para as consultas e gravações e mantém o navegador somente para conectar a conta. Token e cookies ficam criptografados por empresa em `cashbarber-data`, sem publicar portas. `cashbarber.env` contém `CASHBARBER_SECRET` (mesmo segredo em `app.env`) e `CASHBARBER_STORAGE_KEY` (32 bytes em base64). Preserve esses valores e o volume ao atualizar. A URL interna da aplicação é definida no Compose.

Após instalar o conector, entre em **Configurações → CashBarber → Conectar / renovar sessão**. O login realizado no navegador de inspeção do computador não conecta o serviço da VPS. Consulte o [manual do conector](../../cashbarber-bridge/README.md) para funcionamento, recuperação de tentativas e limites.

## Avaliação por IA

A aplicação consulta a fila de avaliações a cada 15 segundos, independentemente de visitantes e do agendador de alertas. A migração `202610230001_attendance_evaluations` cria a fila e a conexão criptografada por empresa; todos os canais começam com a avaliação desligada. Não é necessário definir chave de API da OpenAI para usar a conexão com a conta ChatGPT.

Após atualizar, conecte a conta em **Configurações → Avaliação de atendimento por IA**, execute o conector local indicado na tela, autorize na OpenAI e selecione um modelo. Ative os canais desejados em **Canais de comunicação**. Tokens são renovados pela VPS e entram no backup criptografados pela mesma `APP_ENCRYPTION_KEY` da aplicação. Preserve essa chave. Consulte o [procedimento e limites](../../vercel-app/README.md#avaliação-de-atendimento-por-ia).

## Backup

`acquarella-backup.timer` roda diariamente às 03h15 de São Paulo, com atraso aleatório de até cinco minutos e recuperação de execução perdida. O script verifica o catálogo do dump e a integridade da cópia SQLite. Arquivos ficam em `/opt/acquarella/backups`, acessíveis somente ao root, por aproximadamente 14 dias. O backup inclui banco, sessões e configurações privadas. Deve ser tratado como credencial.

```sh
sudo systemctl start acquarella-backup.service
sudo systemctl list-timers acquarella-backup.timer
sudo journalctl -u acquarella-backup.service -n 20 --no-pager
```

É um backup no mesmo servidor; o backup automático da OVH é uma camada adicional. Uma cópia externa própria ainda pode ser configurada. Não usar `docker compose down -v`: esse comando apaga os volumes.

## Canais

Após criar o administrador, adicionar uma conta WhatsApp com conexão QR e ler o código no telefone em Aparelhos conectados. Cada conta tem sessão própria e armazenamento isolado. O teste de implantação obteve um QR real na VPS, sem vincular telefone nem enviar mensagens. Envio e recebimento com um número real precisam de validação após o pareamento.

Instagram, Messenger e WhatsApp oficial exigem configurar suas próprias contas/tokens e callbacks para a nova origem. A instalação nova não herdou os canais da Vercel.
