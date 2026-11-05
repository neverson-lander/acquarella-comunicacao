import {managesAttendance,worksAttendance} from './attendance-policy.mjs';
export function canReactWhatsAppMessage({user,conversation,account,message,qr}){
  return worksAttendance(user,conversation)&&conversation.account===account.id
    &&account.channel==='whatsapp'&&account.mode==='live'&&qr&&account.enabled!==false&&!account.deleted_at
    &&['in','out'].includes(message.direction)&&['sent','received'].includes(message.state)&&!!message.external&&!message.deletion;
}
export function canDeleteWhatsAppMessage({user,conversation,account,message,qr}){
  return user.role!=='viewer'&&(managesAttendance(user)||message.operator_id===user.id||(!message.operator_id&&message.operator_name==='WhatsApp vinculado'&&conversation.assigned_to===user.id))
    &&user.tenant===conversation.tenant&&conversation.account===account.id
    &&account.channel==='whatsapp'&&account.mode==='live'&&qr&&account.enabled!==false&&!account.deleted_at
    &&message.direction==='out'&&message.state==='sent'&&!!message.external
    &&!message.deletion;
}
