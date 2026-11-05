export function mergeInboxSnapshot(previous,next){
  if(!next.partial||!previous||previous.user.id!==next.user.id||previous.tenant.id!==next.tenant.id)return next;
  const visible=new Set(next.visible_conversation_ids),conversations=new Map(previous.conversations.filter(c=>visible.has(c.id)).map(c=>[c.id,c]));
  for(const c of next.conversations)conversations.set(c.id,c);
  return {...next,conversations:[...conversations.values()].sort((a,b)=>Number(b.updated)-Number(a.updated))};
}
