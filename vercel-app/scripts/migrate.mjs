import {configureAlertScheduler} from '../lib/alert-scheduler.mjs';
import {recoverInboundMedia} from '../lib/recover-inbound-media.mjs';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import assert from 'node:assert/strict';
import { pool } from '../lib/database.mjs';

const tables = ['tenants', 'users', 'accounts', 'conversations', 'messages', 'events', 'jobs', 'audit'];
const protectedTables = [...tables, 'bridge_windows', 'receipts', 'crm_contacts', 'crm_catalog', 'crm_opportunities', 'crm_opportunity_tags', 'crm_touches', 'crm_ads', 'crm_events', 'crm_history', 'crm_settings', 'attendance_history', 'crm_pending_referrals', 'alert_scheduler_requests', 'whatsapp_reactions','reply_attachments','reply_attachment_parts'];
const client = await pool.connect();
try {
  await client.query('begin');
  await client.query("select pg_advisory_xact_lock(94728101)");
  await client.query('create table if not exists app_migrations (id text primary key, applied_at timestamptz not null default now())');
  await client.query('alter table app_migrations enable row level security');
  const exists = await client.query('select id from app_migrations where id=$1', ['202609290001_initial']);
  if (!exists.rowCount) {
    const existing = await client.query("select to_regclass('public.tenants') as name");
    if (existing.rows[0].name) throw new Error('Schema existente sem registro de migração; revisão necessária.');
    await client.query(await readFile(new URL('../supabase/migrations/202609290001_initial.sql', import.meta.url), 'utf8'));
    await client.query('insert into app_migrations(id) values($1)', ['202609290001_initial']);
    console.log('Estrutura PostgreSQL inicializada.');
  }
  const loginMigration = await client.query('select id from app_migrations where id=$1', ['202609290002_login_limits']);
  if (!loginMigration.rowCount) {
    await client.query(await readFile(new URL('../supabase/migrations/202609290002_login_limits.sql', import.meta.url), 'utf8'));
    await client.query('insert into app_migrations(id) values($1)', ['202609290002_login_limits']);
  }
  const whatsappMigration = await client.query('select id from app_migrations where id=$1', ['202609290003_whatsapp_bridge']);
  if (!whatsappMigration.rowCount) {
    await client.query(await readFile(new URL('../supabase/migrations/202609290003_whatsapp_bridge.sql', import.meta.url), 'utf8'));
    await client.query('insert into app_migrations(id) values($1)', ['202609290003_whatsapp_bridge']);
  }
  const imported = await client.query('select id from app_migrations where id=$1', ['20260929_local_import']);
  if (!imported.rowCount && process.env.ACQUARELLA_MIGRATION_DATA) {
    const source = JSON.parse(gunzipSync(Buffer.from(process.env.ACQUARELLA_MIGRATION_DATA, 'base64')));
    const counts = {};
    if (!source.users?.some(u => u.role === 'admin')) throw new Error('Migração sem administrador.');
    for (const table of tables) {
      const occupied = await client.query(`select count(*) as n from ${table}`);
      if (Number(occupied.rows[0].n)) throw new Error(`A tabela ${table} já contém registros; importação cancelada.`);
      const columns = (await client.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position', ['public', table])).rows.map(r => r.column_name);
      for (const row of source[table] || []) {
        const values = columns.map(column => {
          let value = row[column] ?? null;
          if (column === 'bridge' && !value) value = null;
          if (table === 'jobs' && column === 'state' && ['pending', 'sending'].includes(value)) value = 'uncertain';
          if (column === 'accounts' && Array.isArray(value)) value = JSON.stringify(value);
          return value;
        });
        await client.query(`insert into ${table} (${columns.map(c => `"${c}"`).join(',')}) values (${values.map((_, i) => '$' + (i + 1)).join(',')})`, values);
      }
      counts[table] = source[table]?.length || 0;
    }
    await client.query('insert into app_migrations(id) values($1)', ['20260929_local_import']);
    console.log('Dados locais preservados:', JSON.stringify(counts));
  }
  const sacMigration = await client.query('select id from app_migrations where id=$1', ['202609300004_sac']);
  if (!sacMigration.rowCount) {
    await client.query(await readFile(new URL('../supabase/migrations/202609300004_sac.sql', import.meta.url), 'utf8'));
    await client.query('insert into app_migrations(id) values($1)', ['202609300004_sac']);
  }
  const crmMigration = await client.query('select id from app_migrations where id=$1', ['202609300005_crm']);
  if (!crmMigration.rowCount) {
    await client.query(await readFile(new URL('../supabase/migrations/202609300005_crm.sql', import.meta.url), 'utf8'));
    await client.query('insert into app_migrations(id) values($1)', ['202609300005_crm']);
  }
  const attendanceMigration = await client.query('select id from app_migrations where id=$1', ['202609300006_attendance']);
  if (!attendanceMigration.rowCount) {
    await client.query(await readFile(new URL('../supabase/migrations/202609300006_attendance.sql', import.meta.url), 'utf8'));
    await client.query('insert into app_migrations(id) values($1)', ['202609300006_attendance']);
  }
  const alertsMigration=await client.query('select id from app_migrations where id=$1',['202610040009_waiting_alerts']);
  if(!alertsMigration.rowCount){
    await client.query(await readFile(new URL('../supabase/migrations/202610040009_waiting_alerts.sql',import.meta.url),'utf8'));
    await client.query('insert into app_migrations(id) values($1)',['202610040009_waiting_alerts']);
  }
  const recipientsMigration=await client.query('select id from app_migrations where id=$1',['202610040010_alert_recipients']);
  if(!recipientsMigration.rowCount){
    await client.query(await readFile(new URL('../supabase/migrations/202610040010_alert_recipients.sql',import.meta.url),'utf8'));
    await client.query('insert into app_migrations(id) values($1)',['202610040010_alert_recipients']);
  }
  const contentMigration=await client.query('select id from app_migrations where id=$1',['202610040011_whatsapp_content']);
  if(!contentMigration.rowCount){
    await client.query(await readFile(new URL('../supabase/migrations/202610040011_whatsapp_content.sql',import.meta.url),'utf8'));
    await client.query('insert into app_migrations(id) values($1)',['202610040011_whatsapp_content']);
  }
  const schedulingMigration=await client.query('select id from app_migrations where id=$1',['202610020008_closure_scheduling']);
  if(!schedulingMigration.rowCount){
    await client.query(await readFile(new URL('../supabase/migrations/202610020008_closure_scheduling.sql',import.meta.url),'utf8'));
    await client.query('insert into app_migrations(id) values($1)',['202610020008_closure_scheduling']);
  }
  const attributionMigration=await client.query('select id from app_migrations where id=$1',['202609300007_meta_attribution']);
  if(!attributionMigration.rowCount){
    await client.query(await readFile(new URL('../supabase/migrations/202609300007_meta_attribution.sql',import.meta.url),'utf8'));
    await client.query('insert into app_migrations(id) values($1)',['202609300007_meta_attribution']);
  }
  const outboundMigration=await client.query('select id from app_migrations where id=$1',['202610150012_outbound_attachments']);
  if(!outboundMigration.rowCount){
    await client.query(await readFile(new URL('../supabase/migrations/202610150012_outbound_attachments.sql',import.meta.url),'utf8'));
    await client.query('insert into app_migrations(id) values($1)',['202610150012_outbound_attachments']);
  }
  const users = await client.query('select id from users where role=$1 limit 1', ['admin']);
  if (!users.rowCount) throw new Error('Administrador não configurado; publicação interrompida.');
  const encryptionKey = Buffer.from(process.env.APP_ENCRYPTION_KEY || '', 'base64');
  assert.equal(encryptionKey.length, 32, 'Chave de criptografia inválida.');
  const decryptSecret = value => {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  };
  const encryptSecret = value => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  };
  for (const account of (await client.query('select secret from accounts')).rows) {
    decryptSecret(account.secret);
  }
  const inboundMediaMigration=await client.query('select id from app_migrations where id=$1',['202610150013_inbound_media']);
  if(!inboundMediaMigration.rowCount){
    const recovered=await recoverInboundMedia(client,decryptSecret);
    await client.query('insert into app_migrations(id) values($1)',['202610150013_inbound_media']);
    console.log(`Anexos recebidos: ${recovered} mensagens recuperadas dos webhooks existentes.`);
  }
  const sharedMediaMigration=await client.query('select id from app_migrations where id=$1',['202610150014_shared_media']);
  if(!sharedMediaMigration.rowCount){
    const recovered=await recoverInboundMedia(client,decryptSecret);
    await client.query('insert into app_migrations(id) values($1)',['202610150014_shared_media']);
    console.log(`Mídias compartilhadas: ${recovered} mensagens recuperadas.`);
  }
  const unsupportedMigration=await client.query('select id from app_migrations where id=$1',['202610150015_unsupported_media']);
  if(!unsupportedMigration.rowCount){
    const recovered=await recoverInboundMedia(client,decryptSecret);
    await client.query('insert into app_migrations(id) values($1)',['202610150015_unsupported_media']);
    console.log(`Avisos de conteúdo não disponibilizado pela Meta: ${recovered} mensagens atualizadas.`);
  }
  const deletedMigration=await client.query('select id from app_migrations where id=$1',['202610150016_deleted_messages']);
  if(!deletedMigration.rowCount){
    const recovered=await recoverInboundMedia(client,decryptSecret);
    await client.query('insert into app_migrations(id) values($1)',['202610150016_deleted_messages']);
    console.log(`Avisos de exclusão de mensagens: ${recovered} registros corrigidos.`);
  }
  const webhookConfigured = await client.query('select id from app_migrations where id=$1', ['20260929_whatsapp_webhook']);
  if (!webhookConfigured.rowCount) {
    const whatsapp = (await client.query("select * from accounts where channel='whatsapp' and mode='live' limit 1")).rows[0];
    const sibling = whatsapp && (await client.query("select secret from accounts where tenant=$1 and channel in ('messenger','instagram') and mode='live' order by case channel when 'messenger' then 0 else 1 end limit 1", [whatsapp.tenant])).rows[0];
    if (whatsapp && sibling) {
      const waSecret = decryptSecret(whatsapp.secret), metaSecret = decryptSecret(sibling.secret);
      const appId = process.env.META_APP_ID || '1062549136589562';
      const form = new URLSearchParams({object:'whatsapp_business_account',callback_url:`https://acquarella-comunicacao.vercel.app/webhooks/meta/${whatsapp.id}`,fields:'messages',verify_token:waSecret.verifyToken,access_token:`${appId}|${metaSecret.appSecret}`});
      const subscription = await fetch(`https://graph.facebook.com/v26.0/${appId}/subscriptions`, {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form});
      const subscriptionResult = await subscription.json();
      if (!subscription.ok || !subscriptionResult.success) throw new Error(`Webhook WhatsApp recusado pela Meta (${subscription.status}/${subscriptionResult.error?.code || 'sem código'}).`);
      const enrollment = await fetch(`https://graph.facebook.com/v26.0/${process.env.WHATSAPP_WABA_ID || '2509343702892515'}/subscribed_apps`, {method:'POST',headers:{Authorization:`Bearer ${waSecret.token}`}});
      const enrollmentResult = await enrollment.json();
      if (!enrollment.ok || !enrollmentResult.success) throw new Error(`Inscrição WhatsApp recusada pela Meta (${enrollment.status}/${enrollmentResult.error?.code || 'sem código'}).`);
      await client.query('insert into app_migrations(id) values($1)', ['20260929_whatsapp_webhook']);
      console.log('Webhook do WhatsApp e conta de teste inscritos na Meta.');
    }
  }
  const metaWebhooksConfigured = await client.query('select id from app_migrations where id=$1', ['20260929_meta_webhooks']);
  if (!metaWebhooksConfigured.rowCount) {
    const messenger = (await client.query("select * from accounts where channel='messenger' and mode='live' limit 1")).rows[0];
    const instagram = (await client.query("select * from accounts where channel='instagram' and mode='live' limit 1")).rows[0];
    if (messenger && instagram) {
      const metaSecret = decryptSecret(messenger.secret), instagramSecret = decryptSecret(instagram.secret);
      await client.query('update accounts set secret=$1 where id=$2', [encryptSecret(instagramSecret), instagram.id]);
      const appId = process.env.META_APP_ID || '1062549136589562';
      for (const [object, account, secret] of [['instagram', instagram, instagramSecret], ['page', messenger, metaSecret]]) {
        const form = new URLSearchParams({object,callback_url:`https://acquarella-comunicacao.vercel.app/webhooks/meta/${account.id}`,fields:'messages',verify_token:secret.verifyToken,access_token:`${appId}|${metaSecret.appSecret}`});
        const response = await fetch(`https://graph.facebook.com/v26.0/${appId}/subscriptions`, {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form});
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(`Webhook ${object} recusado pela Meta (${response.status}/${result.error?.code || 'sem código'}).`);
      }
      await client.query('insert into app_migrations(id) values($1)', ['20260929_meta_webhooks']);
      console.log('Webhooks do Instagram e Messenger apontados para a produção.');
    }
  }
  const referralsConfigured=await client.query('select id from app_migrations where id=$1',['20261001_instagram_referrals']);
  if(!referralsConfigured.rowCount){
    const instagram=(await client.query("select * from accounts where channel='instagram' and mode='live' limit 1")).rows[0];
    const sibling=instagram&&(await client.query("select secret from accounts where tenant=$1 and channel='messenger' and mode='live' limit 1",[instagram.tenant])).rows[0];
    if(instagram&&sibling){
      const secret=decryptSecret(instagram.secret),appSecret=decryptSecret(sibling.secret).appSecret;
      const appId=process.env.META_APP_ID||'1062549136589562';
      const form=new URLSearchParams({object:'instagram',callback_url:`https://acquarella-comunicacao.vercel.app/webhooks/meta/${instagram.id}`,fields:'messages,messaging_referral',verify_token:secret.verifyToken,access_token:`${appId}|${appSecret}`});
      const response=await fetch(`https://graph.facebook.com/v26.0/${appId}/subscriptions`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(10000)});
      const result=await response.json();
      if(!response.ok||!result.success)throw Error(`Referências do Instagram recusadas (${response.status}/${result.error?.code||'sem código'}).`);
      const enrollment=await fetch(`https://graph.instagram.com/v26.0/${encodeURIComponent(secret.instagramApiId||instagram.external)}/subscribed_apps`,{method:'POST',headers:{Authorization:`Bearer ${secret.token}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({subscribed_fields:'messages,messaging_referral'}),signal:AbortSignal.timeout(10000)});
      const enrollmentResult=await enrollment.json();
      if(!enrollment.ok||!enrollmentResult.success)throw Error(`Inscrição das referências do Instagram recusada (${enrollment.status}/${enrollmentResult.error?.code||'sem código'}).`);
      await client.query('insert into app_migrations(id) values($1)',['20261001_instagram_referrals']);
      console.log('Referências de anúncios do Instagram inscritas no aplicativo e na conta.');
    }
  }
  const rls = await client.query('select relname,relrowsecurity from pg_class where relnamespace=$1::regnamespace and relname = any($2::text[])', ['public', protectedTables]);
  assert.equal(rls.rows.length, protectedTables.length);
  assert.ok(rls.rows.every(r => r.relrowsecurity), 'Todas as tabelas devem usar RLS.');
  const serviceHoursMigration='20261016034928_channel_service_hours';
  if(!(await client.query('select id from app_migrations where id=$1',[serviceHoursMigration])).rowCount){
    await client.query(await readFile(new URL('../supabase/migrations/'+serviceHoursMigration+'.sql',import.meta.url),'utf8'));
    await client.query('insert into app_migrations(id) values($1)',[serviceHoursMigration]);
  }
  const contactsMigration='20261016042106_contact_directory_and_channel_activation';
  if(!(await client.query('select id from app_migrations where id=$1',[contactsMigration])).rowCount){
    await client.query(await readFile(new URL('../supabase/migrations/'+contactsMigration+'.sql',import.meta.url),'utf8'));
    await client.query('insert into app_migrations(id) values($1)',[contactsMigration]);
  }
  await configureAlertScheduler(client);
  await client.query('commit');
  console.log('Agendador de alertas ativo: verificação a cada minuto.');
  console.log('Migração e criptografia verificadas; RLS ativo nas tabelas da aplicação.');
} catch (error) {
  await client.query('rollback');
  console.error('Falha na migração:', error.code || error.message);
  process.exitCode = 1;
} finally {
  client.release();
}

if (!process.exitCode) {
  let sessionHash;
  try {
    const { default: app } = await import('../api/index.mjs');
    const origin = 'https://acquarella-comunicacao.vercel.app';
    const bootstrap = await app.fetch(new Request(origin + '/api/bootstrap'));
    assert.equal(bootstrap.status, 200);
    assert.equal((await bootstrap.json()).setup, false);
    assert.equal((await app.fetch(new Request(origin + '/api/state'))).status, 401);
    const user = (await pool.query("select id from users where role='admin' limit 1")).rows[0];
    const session = randomBytes(32).toString('hex');
    sessionHash = createHash('sha256').update(session).digest('hex');
    await pool.query('insert into sessions(id,"user",expires) values($1,$2,$3)', [sessionHash, user.id, Date.now() + 60000]);
    const response = await app.fetch(new Request(origin + '/api/state', { headers: { cookie: `session=${session}` } }));
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.user.role, 'admin');
    assert.ok(state.accounts.length > 0);
    assert.ok(state.users.every(u => Array.isArray(u.accounts)));
    assert.ok(state.conversations.every(c => typeof c.updated === 'number'));
    assert.ok(state.accounts.every(a => !a.secret && a.webhook));
    assert.ok(state.accounts.every(a => typeof a.forwarding_enabled === 'boolean'));
    assert.ok(state.accounts.every(a => typeof a.alerts_enabled === 'boolean' && Number.isInteger(a.queue_alert_minutes) && Number.isInteger(a.assigned_alert_minutes) && Array.isArray(a.alerts_phones)));
    assert.equal((await app.fetch(new Request(origin+'/api/internal/waiting-alerts'))).status,401);
    assert.ok(state.conversations.every(c => typeof c.username === 'string' && typeof c.name_manual === 'boolean'));
    assert.ok(state.conversations.every(c => c.messages.every(m => 'operator_name' in m && 'operator_id' in m)));
    assert.ok(state.conversations.every(c => c.messages.every(m => typeof m.kind==='string' && m.media && Array.isArray(m.reactions) && m.kind!=='reaction')));
    const attachments=state.conversations.flatMap(c=>c.messages).filter(m=>['image','audio','sticker'].includes(m.kind)&&m.media?.id).sort((a,b)=>b.created-a.created);
    console.log(`Conteúdo WhatsApp: ${attachments.length} anexos recuperados; reações vinculadas às mensagens.`);
    if(attachments.length){
      const mediaResponse=await app.fetch(new Request(origin+'/api/messages/'+attachments[0].id+'/media',{headers:{cookie:`session=${session}`}}));
      if(mediaResponse.ok){const bytes=await mediaResponse.arrayBuffer();assert.ok(bytes.byteLength>0);console.log(`Anexo real da Meta validado: ${attachments[0].kind}, ${bytes.byteLength} bytes.`);}
      else console.log(`Anexo antigo consultado na Meta: HTTP ${mediaResponse.status}; pode estar indisponível.`);
    }
    assert.ok(state.conversations.every(c => 'assigned_to' in c && Array.isArray(c.attendance_history)));
    const crmResponse=await app.fetch(new Request(origin+'/api/crm/state',{headers:{cookie:`session=${session}`}}));
    assert.equal(crmResponse.status,200);
    const crm=await crmResponse.json();
    assert.ok(Array.isArray(crm.opportunities)&&Array.isArray(crm.catalog)&&Array.isArray(crm.events));
    assert.ok(!('secret' in crm)&&!('token' in crm));
    console.log('Verificação integrada: autenticação, dados do administrador, permissões e datas corretos.');
  } catch (error) {
    console.error('Falha na verificação integrada:', error.code || error.message);
    process.exitCode = 1;
  } finally {
    if (sessionHash) await pool.query('delete from sessions where id=$1', [sessionHash]);
  }
}
if(!process.exitCode&&process.env.INSPECT_ALERT_DELIVERIES==='1')await import('./inspect-alert-deliveries.mjs');
await pool.end();
