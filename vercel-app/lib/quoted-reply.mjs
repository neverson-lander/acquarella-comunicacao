import {canQuoteMessage,quoteExcerpt} from '../public/quoted-reply.mjs';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export async function resolveQuotedReply({pool,conversation,account,messageId}){
  if(messageId===undefined||messageId===null||messageId==='')return null;
  if(account.channel!=='whatsapp')fail('A resposta a uma mensagem específica está disponível no WhatsApp.');
  if(typeof messageId!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(messageId)))fail('Mensagem de referência inválida.');
  const message=(await pool.query(`select m.*,exists(select 1 from whatsapp_deletions d where d.tenant=$3 and d.account=$4 and d.customer=$5
    and (d.target_external=m.external or $4::text||':'||d.target_external=m.external)) as removed
    from messages m where m.id=$1 and m.conversation=$2`,[messageId,conversation.id,conversation.tenant,account.id,conversation.customer])).rows[0];
  if(!message||message.removed||!canQuoteMessage(message))fail('Esta mensagem não está disponível para responder.',409);
  const external=message.external.startsWith(account.id+':')?message.external.slice(account.id.length+1):message.external;
  if(!external||external.length>200||/[\s\x00-\x1f]/.test(external))fail('Esta mensagem não possui uma referência válida no WhatsApp.',409);
  return {messageId:message.id,external,body:quoteExcerpt(message),name:String(conversation.name||'Cliente').slice(0,200),kind:message.kind||'text'};
}
