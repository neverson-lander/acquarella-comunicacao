import {instagramMessageType,attendanceRelevant} from './instagram-attendance.mjs';
import { sameWhatsAppPhone } from './whatsapp-phone.mjs';
import { inboundWhatsApp, forwardingAllowed,forwardingPhone, signedReply } from './sac.mjs';
import {reopenInbound} from './attendance-inbound.mjs';
import {findWhatsAppConversation,whatsappCustomerPhone} from './whatsapp-conversation.mjs';
import {metaAttachments,incomingBody} from './inbound-media.mjs';

export function createInboundHandler({ one, run, id, now, open, profile, send, queue, audit, capture = async()=>{}, captureReferral=async()=>{}, alertRecipients=async()=>[], forwardRecipients=async()=>[], captureReaction=async()=>{}, captureDeletion=async()=>{}, requiresWindow=()=>true }) {
  async function editMessage(account,message,fromMe,receivedAt){
    const target=await one(`select m.*,c.customer from messages m join conversations c on c.id=m.conversation
      where c.tenant=$1 and c.account=$2 and m.external in ($3,$4)`,[account.tenant,account.id,message.edit.target,account.id+':'+message.edit.target]);
    if(!target){if(!fromMe)await receive(account,{...message,kind:'text',body:'[Mensagem editada no WhatsApp]\n'+message.body},receivedAt);return;}
    if(!sameWhatsAppPhone(target.customer,message.customer)||target.direction!==(fromMe?'out':'in'))return;
    const changed=await one(`update messages set body=$2,media=media||jsonb_build_object('edited',jsonb_build_object('at',$3::bigint,'source','whatsapp','name',$4::text,'original_body',coalesce(media->'edited'->>'original_body',body)))||case when kind in ('image','video','document') then jsonb_build_object('caption',$2::text) else '{}'::jsonb end
      where id=$1 and coalesce((media->'edited'->>'at')::bigint,0)<$3 returning id`,[target.id,message.body,message.timestamp,fromMe?'WhatsApp vinculado':'Cliente']);
    if(changed)await run('update conversations set updated=greatest(updated,$2) where id=$1',[target.conversation,now()]);
  }
  async function receive(account, message, receivedAt) {
    const external = `${account.id}:${message.external}`;
    if (await one('select id from messages where external=$1', [external])) return;
    let conversation = account.channel==='whatsapp'?await findWhatsAppConversation(one,account,message.customer):await one('select * from conversations where account=$1 and customer=$2', [account.id, message.customer]);
    let identity = { name: message.name || '', username: '' };
    let attemptedProfile = false;
    if (account.channel !== 'whatsapp' && (!conversation || now() - Number(conversation.profile_checked || 0) > 86400000)) {
      attemptedProfile = true;
      identity = await profile(account, message.customer);
    }
    if (!conversation) {
      const name = identity.name || identity.username || (account.channel === 'whatsapp' ? `+${message.customer}` : `${account.channel === 'instagram' ? 'Instagram' : 'Messenger'} ${message.customer}`);
      conversation = await one("insert into conversations(id,tenant,account,customer,name,username,profile_checked,status,updated,last_inbound,attendance_eligible) values($1,$2,$3,$4,$5,$6,$7,'open',$8,$8,$9) on conflict(account,customer) do update set updated=greatest(conversations.updated,excluded.updated) returning *", [id(), account.tenant, account.id, account.channel==='whatsapp'?(whatsappCustomerPhone(message.customer)):message.customer, name, identity.username || '', now(), message.timestamp,account.channel!=='instagram'||message.service_type==='text']);
    } else if (identity.name || identity.username) {
      await run("update conversations set name=case when name_manual then name else $1 end,username=case when $2='' then username else $2 end,profile_checked=$3 where id=$4", [identity.name || identity.username || conversation.name, identity.username || '', now(), conversation.id]);
      if (!conversation.name_manual) conversation.name = identity.name || identity.username || conversation.name;
    } else if (attemptedProfile) {
      await run('update conversations set profile_checked=$1 where id=$2', [now(), conversation.id]);
    }
    const relevant=attendanceRelevant(account,conversation,message);
    if(relevant){
      if(conversation.attendance_eligible===false)await run('update crm_opportunities set first_contact=$1 where conversation=$2',[message.timestamp,conversation.id]);
      await capture(conversation, account, message);
    }
    else if(message.referral)await captureReferral(account,message);
    const mid = id();
    const inserted = await one("insert into messages(id,conversation,direction,body,created,state,external,received_at) values($1,$2,'in',$3,$4,'received',$5,$6) on conflict(external) do nothing returning id", [mid, conversation.id, message.body, message.timestamp, external, receivedAt]);
    if (!inserted) return;
    if(message.media||message.kind&&message.kind!=='text')await run('update messages set kind=$1,media=$2 where id=$3',[message.kind,JSON.stringify(message.media||{}),mid]);
    if(!relevant){
      await run('update messages set attendance_relevant=false where id=$1',[mid]);
      await run('update conversations set updated=greatest(updated,$1),last_inbound=greatest(last_inbound,$1) where id=$2',[message.timestamp,conversation.id]);
      return;
    }
    await reopenInbound(run,conversation,now(),message.timestamp);
    const bridge = account.bridge ? await one('select * from accounts where id=$1 and tenant=$2', [account.bridge, account.tenant]) : account.channel==='whatsapp'?account:null;
    if (!bridge) return;
    const tenant = await one('select * from tenants where id=$1', [account.tenant]);
    if (forwardingAllowed(account, bridge, message.customer, tenant.phone,message.timestamp)) {
      await queue(bridge, conversation, mid, 'forward', forwardingPhone(account,tenant.phone), `[${account.channel === 'instagram' ? 'Instagram' : account.channel === 'whatsapp' ? 'WhatsApp' : 'Messenger'} · ${account.name}]\n${conversation.name}\n\n${message.body}\n\nUse Responder e cite esta mensagem para retornar ao cliente.`.slice(0, 4000));
    }
  }

  return async function processInbound(account, payload) {
    if(account.enabled===false)return;
    // Capture arrival before profile lookups, CRM work and forwarding. A retry
    // cannot overwrite this value because the message insert is idempotent.
    const receivedAt=now();
    if (account.channel === 'whatsapp') {
      for (const entry of payload.entry || []) for (const change of entry.changes || []) {
        const value = change.value || {};
        if (String(value.metadata?.phone_number_id) !== String(account.external)) continue;
        for (const status of value.statuses || []) {
          if (status.status !== 'failed') continue;
          await run("update jobs set state='failed',error='A Meta informou falha na entrega.' where account=$1 and external=$2", [account.id, status.id]);
          await run("update messages set state='failed' where external=$1 and conversation in (select id from conversations where account=$2)", [status.id, account.id]);
        }
        for (const message of inboundWhatsApp(value)) {
          if(message.timestamp<Number(account.receive_after||0))continue;
          if(message.deletion||message.reaction){
            const existing=await findWhatsAppConversation(one,account,message.customer);
            if(existing)message.customer=existing.customer;
          }
          if(message.deletion){await captureDeletion(account,message);continue;}
          if(message.reaction){await captureReaction(account,{...message,fromMe:payload.qrEcho===true});continue;}
          if(message.edit){await editMessage(account,message,payload.qrEcho===true,receivedAt);continue;}
          if(payload.qrEcho){
            // Echoes from the linked phone do not renew a customer's service
            // window, reopen resolved attendance or acquire an operator identity.
            if(await one('select id from messages where external=$1',[message.external]))continue;
            const c=await findWhatsAppConversation(one,account,message.customer)||await one("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,$4,$5,'open',$6,0) on conflict(account,customer) do update set updated=greatest(conversations.updated,excluded.updated) returning *",[id(),account.tenant,account.id,whatsappCustomerPhone(message.customer),`+${message.customer}`,message.timestamp]);
            const inserted=await one("insert into messages(id,conversation,direction,body,created,state,external,operator_name) values($1,$2,'out',$3,$4,'sent',$5,'WhatsApp vinculado') on conflict(external) do nothing returning id",[id(),c.id,message.body,message.timestamp,message.external]);
            if(inserted){if(message.media)await run('update messages set kind=$1,media=$2 where id=$3',[message.kind,JSON.stringify(message.media),inserted.id]);await run('update conversations set updated=greatest(updated,$1) where id=$2',[message.timestamp,c.id]);}
            continue;
          }
          const tenant = await one('select * from tenants where id=$1', [account.tenant]);
          const team=sameWhatsAppPhone(message.customer,tenant.phone);
          const alertRecipient=(await alertRecipients(account)).find(phone=>sameWhatsAppPhone(message.customer,phone));
          const forwardRecipient=(await forwardRecipients(account)).find(phone=>sameWhatsAppPhone(message.customer,phone));
          // Store each incoming customer's own service window too, so registering
          // an existing contact as an alert recipient preserves its open window.
          await run('insert into bridge_windows(account,phone,seen) values($1,$2,$3) on conflict(account,phone) do update set seen=greatest(bridge_windows.seen,excluded.seen)', [account.id,team?tenant.phone:forwardRecipient||alertRecipient||message.customer,message.timestamp]);
          // Only the actual recipient of a forwarded message can quote it to
          // reply. Custom per-channel destinations never grant general access.
          const job = message.context && await one("select * from jobs where account=$1 and external=$2 and kind='forward' and tenant=$3", [account.id, message.context, account.tenant]);
          if (job && sameWhatsAppPhone(message.customer,job.recipient||tenant.phone)) {
              const receipt = await one('insert into receipts(account,external) values($1,$2) on conflict do nothing returning external', [account.id, message.external]);
              if (!receipt) continue;
              const c = await one('select * from conversations where id=$1 and tenant=$2', [job.conversation, account.tenant]);
              const origin = c && await one('select * from accounts where id=$1', [c.account]);
              if (!origin || !forwardingAllowed(origin, account, c.customer, tenant.phone,null) || !sameWhatsAppPhone(forwardingPhone(origin,tenant.phone),job.recipient||tenant.phone)) {
                await audit(account.tenant, 'Resposta da ponte não enviada: encaminhamento desativado.');
                await receive(account, message, receivedAt);
                continue;
              }
              if (requiresWindow(origin) && now() - Number(c.last_inbound) > 86400000) {
                await audit(account.tenant, 'Resposta da ponte não enviada: janela do cliente encerrada.');
                await receive(account, message, receivedAt);
                continue;
              }
              try {
                const body = message.body.slice(0, 1950);
                const external = await send(origin, c.customer, signedReply('Equipe WhatsApp', body));
                await run("insert into messages(id,conversation,direction,body,created,state,external,operator_name) values($1,$2,'out',$3,$4,'sent',$5,$6)", [id(), c.id, body, now(), external, 'Equipe WhatsApp']);
                await run('update conversations set updated=$1 where id=$2', [now(), c.id]);
              } catch (error) {
                await audit(account.tenant, `Falha ao devolver resposta do WhatsApp: ${String(error.message || error).slice(0, 180)}`);
                await receive(account, message, receivedAt);
              }
              continue;
          }
          // Alert recipients can renew their window but gain no bridge privileges.
          if(alertRecipient&&!team)continue;
          await receive(account, message, receivedAt);
        }
      }
      return;
    }
    const accountIds = account.channel === 'instagram' ? [String(account.external), ...(open(account.secret).instagramIds || [])] : [String(account.external)];
    for (const entry of payload.entry || []) {
      if (!accountIds.includes(String(entry.id))) continue;
      const items = [...(entry.messaging || []), ...(entry.changes || []).filter(x => ['messages','messaging_referral','messaging_referrals'].includes(x.field)).map(x => x.value || {})];
      for (const m of items) {
        const received=Number(m.timestamp)||now();if((received<1e12?received*1000:received)<Number(account.receive_after||0))continue;
        if(m.message?.is_deleted&&m.message.mid){
          await run("update messages set kind='deleted',media='{}'::jsonb,body=$1 where external=$2 and direction='in'",[`[Mensagem excluída no ${account.channel==='instagram'?'Instagram':'Messenger'}.]`,account.id+':'+m.message.mid]);
          continue;
        }
        const referral=m.referral||m.postback?.referral;
        if(referral&&!m.message?.mid&&m.sender?.id){const stamp=Number(m.timestamp)||now();await captureReferral(account,{customer:String(m.sender.id),referral,external:`referral:${m.sender.id}:${stamp}:${referral.ad_id||referral.source_id||''}`,timestamp:stamp<1e12?stamp*1000:stamp});}
        if (!m.message || m.message.is_echo || !m.message.mid || !m.sender?.id) continue;
        const stamp = Number(m.timestamp) || now();
        await receive(account, { customer: String(m.sender.id), external: m.message.mid, body: incomingBody(m.message),...(account.channel==='instagram'?{service_type:instagramMessageType(m.message)}:{}),...(metaAttachments(m.message)||{}), referral: m.referral || m.message.referral, timestamp: stamp < 1e12 ? stamp * 1000 : stamp }, receivedAt);
      }
    }
  };
}
