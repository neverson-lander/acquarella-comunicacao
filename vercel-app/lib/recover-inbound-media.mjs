import {metaAttachments,incomingBody} from './inbound-media.mjs';
import {inboundWhatsApp} from './sac.mjs';
export async function recoverInboundMedia(client,open){
 const records=(await client.query(`select a.id,a.channel,a.external,a.secret,e.payload from accounts a
 join events e on e.tenant=a.tenant::text
 where exists(select 1 from messages m join conversations c on c.id=m.conversation
 where c.account=a.id and m.direction='in') order by e.created`)).rows;
 let recovered=0;
 for(const account of records){
  const entries=Array.isArray(account.payload?.entry)?account.payload.entry:[],ids=account.channel==='instagram'?[account.external,...(open(account.secret).instagramIds||[])]:[account.external];
  const messages=[];
  for(const entry of entries){
   if(account.channel==='whatsapp'){
    for(const change of entry.changes||[]){const value=change.value||{};if(String(value.metadata?.phone_number_id)===String(account.external))for(const message of inboundWhatsApp(value))if(message.media)messages.push(message);}
   }else if(ids.map(String).includes(String(entry.id))){
    const items=[...(entry.messaging||[]),...(entry.changes||[]).filter(x=>x.field==='messages').map(x=>x.value||{})];
    for(const item of items){const parsed=metaAttachments(item.message);if(item.message?.mid&&!item.message.is_echo&&(parsed||!item.message.text))messages.push(item.message.is_deleted?{external:item.message.mid,body:`[Mensagem excluída no ${account.channel==='instagram'?'Instagram':'Messenger'}.]`,kind:'deleted',media:{}}:{external:item.message.mid,body:incomingBody(item.message),...(parsed||{kind:'unsupported',media:{}})});}
   }
  }
  for(const message of messages){const result=await client.query("update messages set kind=$1,media=$2,body=$3 where external=$4 and direction='in' and ($1='deleted' or (media='{}'::jsonb and kind<>'deleted')) and (kind is distinct from $1 or body is distinct from $3)",[message.kind,JSON.stringify(message.media),message.body,account.id+':'+message.external]);recovered+=result.rowCount||0;}
 }
 return recovered;
}
