// Keep social interactions in history without inferring a service request.
export function instagramMessageType(message={}){
 const attachments=Array.isArray(message.attachments)?message.attachments:message.attachments?.data||[];
 if(attachments.some(a=>!['image','audio','video','file','document','sticker'].includes(a.type)))return 'social';
 if(message.is_unsupported||message.reaction||message.is_story_mention)return 'social';
 const text=typeof message.text==='string'?message.text.trim():'';
 if(message.reply_to?.story&&text&&!/[\p{L}\p{N}]/u.test(text))return 'social';
 if(text)return 'text';
 return attachments.length?'media':'social';
}
export function attendanceRelevant(account,conversation,message){
 if(account.channel!=='instagram')return true;
 return message.service_type==='text'||message.service_type==='media'&&conversation?.status==='open'&&conversation.attendance_eligible!==false;
}
