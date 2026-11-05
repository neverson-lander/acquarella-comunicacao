import {canReplyAttendance,managesAttendance} from './attendance-policy.mjs';
export function canForwardMessage({user,conversation,account,message,qr}){
 return canReplyAttendance(user,conversation)&&user.tenant===conversation.tenant&&conversation.account===account.id
  &&account.channel==='whatsapp'&&account.mode==='live'&&qr&&account.enabled!==false&&!account.deleted_at
  &&['in','out'].includes(message.direction)&&['sent','received'].includes(message.state)&&!!message.external&&!message.deletion
  &&['text','image','video','audio','document','file','sticker'].includes(message.kind||'text');
}
export function canEditMessage(context,now=Date.now()){
 const {user,message,conversation}=context;
 return canForwardMessage(context)&&message.direction==='out'&&(message.kind||'text')==='text'
  &&(message.operator_id?(message.operator_id===user.id||managesAttendance(user)):(message.operator_name==='WhatsApp vinculado'&&(conversation.assigned_to===user.id||managesAttendance(user))))
  &&Number(message.created)<=now&&now-Number(message.created)<15*60000;
}
