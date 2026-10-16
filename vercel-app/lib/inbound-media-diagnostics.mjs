// Administrator-only metadata: no message bodies, signed CDN links, tokens or customer contents.
export async function inboundMediaDiagnostics({pool,conversation,account}){
 const messages=(await pool.query("select id,external,kind,media from messages where conversation=$1 and direction='in' order by created desc limit 10",[conversation.id])).rows;
 const events=(await pool.query('select payload from events where tenant=$1 order by created desc limit 200',[String(conversation.tenant)])).rows;
 const source=new Map();
 for(const event of events)for(const entry of event.payload?.entry||[]){
  const items=[...(entry.messaging||[]),...(entry.changes||[]).map(c=>c.value||{})];
  for(const item of items)if(item.message?.mid&&!source.has(String(item.message.mid)))source.set(String(item.message.mid),item.message);
 }
 return {channel:account.channel,messages:messages.map(message=>{
  const external=message.external?.startsWith(account.id+':')?message.external.slice(account.id.length+1):'',raw=source.get(external);
  return {id:message.id,kind:message.kind,hasMedia:!!(message.media?.id||message.media?.items?.length),sourceFound:!!raw,unsupported:raw?.is_unsupported===true,deleted:raw?.is_deleted===true,
   fields:raw?Object.keys(raw):[],attachments:(Array.isArray(raw?.attachments)?raw.attachments:[]).map(a=>({type:a.type||'',fields:Object.keys(a),payloadFields:Object.keys(a.payload||{}),hasUrl:!!(a.payload?.url||a.url||a.file_url)}))};
 })};
}
