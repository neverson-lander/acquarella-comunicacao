const inbound = c => (c.messages || []).filter(m => m.direction === 'in' && m.attendance_relevant !== false && m.kind !== 'reaction');
const timestamp=value=>{const n=Number(value);return Number.isFinite(n)&&n>0?n:null;};
const lastReplyAt=c=>Math.max(0,...(c.messages||[]).filter(m=>m.direction==='out'&&m.state==='sent'&&m.kind!=='reaction').map(m=>timestamp(m.created)||0));

export function visualAlertMinutes(account,scope='queue'){
 const value=account?.[scope==='assigned'?'visual_assigned_minutes':'visual_queue_minutes'];
 if(Number.isInteger(value)&&value>=1&&value<=1440)return value;
 return Number.isInteger(account?.visual_alert_minutes)&&account.visual_alert_minutes>=1&&account.visual_alert_minutes<=1440?account.visual_alert_minutes:30;
}
export function lastConversationMessage(c){
 return (c.messages||[]).filter(m=>m.kind!=='reaction'&&m.attendance_relevant!==false&&timestamp(m.created)!==null&&(m.direction==='in'||m.direction==='out'&&m.state==='sent')).reduce((last,m)=>!last||Number(m.created)>=Number(last.created)?m:last,null);
}
export function conversationAttention(c,account,now=Date.now()){
 const last=lastConversationMessage(c),since=c.assigned_to?timestamp(last?.created):queueWaitingSince(c),minutes=visualAlertMinutes(account,c.assigned_to?'assigned':'queue');
 const eligible=c.status==='open'&&c.attendance_eligible!==false&&account?.enabled!==false&&!account?.deleted_at;
 return {last,since,minutes,followUp:!!c.assigned_to&&last?.direction==='out',overdue:eligible&&since!==null&&now-since>=minutes*60000};
}
export const suppressConversationPush=(c,user)=>c?.status==='open'&&c.assigned_to===user?.id&&lastConversationMessage(c)?.direction==='out';
export function scopeConversations(snapshot,scope){return snapshot.conversations.filter(c=>c.status==='open'&&(scope==='queue'?c.attendance_eligible!==false&&!c.assigned_to:scope==='mine'?c.assigned_to===snapshot.user.id:scope==='interactions'?c.attendance_eligible===false:true));}
export function scopeIndicators(snapshot,scope,unread=new Map(),now=Date.now()){
 const items=scopeConversations(snapshot,scope);
 const attention=['queue','mine'].includes(scope)?items.map(c=>conversationAttention(c,snapshot.accounts.find(a=>a.id===c.account),now)).filter(a=>a.overdue):[];
 return {total:items.length,unread:items.filter(c=>unread.get(c.id)>0).length,attention:attention.filter(a=>!a.followUp).length,followUp:attention.filter(a=>a.followUp).length};
}

// Failed/simulated outbound messages do not end a customer's wait.
export function waitingSince(c) {
  if(c.attendance_eligible===false)return null;
  const lastReply = lastReplyAt(c);
  const pending = inbound(c).map(m=>timestamp(m.created)).filter(t=>t!==null&&t>lastReply);
  return pending.length ? Math.min(...pending) : null;
}
export function queueWaitingSince(c){
  if(c.attendance_eligible===false)return null;
  const entries=(c.attendance_history||[]).filter(h=>h.next_owner===null&&(/para a fila/.test(h.action)||/devolvido à fila/.test(h.action))).map(h=>timestamp(h.created)).filter(t=>t!==null);
  const arrival=entries.length?Math.max(...entries):timestamp(c.assigned_at),pending=waitingSince(c);
  // A phone reply ends the customer's wait even while the case is unassigned.
  if(pending===null&&lastReplyAt(c)>0)return null;
  if(arrival!==null)return Math.max(arrival,pending||0);
  return pending??timestamp(c.last_inbound)??timestamp(c.updated);
}
export const conversationWaitingSince=c=>c.status==='open'&&!c.assigned_to?queueWaitingSince(c):waitingSince(c);
export function waitLabel(since, now = Date.now()) {
  if (timestamp(since)===null) return 'Sem espera pendente';
  const minutes = Math.max(0, Math.floor((now - since) / 60000));
  if (minutes < 1) return 'Agora';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${Math.floor(minutes / 1440)} d ${Math.floor(minutes % 1440 / 60)} h`;
}
export function prioritize(conversations, scope, unread = new Map()) {
  return [...conversations].sort((a, b) => {
    if (scope === 'queue') return (queueWaitingSince(a)??Infinity) - (queueWaitingSince(b)??Infinity) || a.id.localeCompare(b.id);
    return Number(!!unread.get(b.id)) - Number(!!unread.get(a.id)) || Number(lastConversationMessage(b)?.created||b.updated) - Number(lastConversationMessage(a)?.created||a.updated);
  });
}

// Follow authorized snapshots, establishing a quiet baseline on login. Assigned
// cases include successful outgoing messages from colleagues or the linked phone.
export function createMessageObserver() {
  let identity, since = 0, seen = new Map();
  function reset() { identity = null; since = 0; seen.clear(); }
  function observe(snapshot) {
    const key = `${snapshot.tenant.id || snapshot.tenant.name}:${snapshot.user.id}`;
    const initial = key !== identity;
    if (initial) { reset(); identity = key; }
    const changes = [];
    const nextSeen = new Map();
    for (const c of snapshot.conversations) {
      const tracked=(c.messages||[]).filter(m=>m.kind!=='reaction'&&m.attendance_relevant!==false&&(m.direction==='in'||m.direction==='out'&&m.state==='sent'));
      const messages = c.assigned_to?tracked:inbound(c);
      const previous = seen.get(c.id);
      const fresh = initial ? [] : messages.filter(m => !previous?.has(m.id) && (previous || Number(m.created) >= since) && !(m.direction==='out'&&m.operator_id===snapshot.user.id)).sort((a,b)=>Number(a.created)-Number(b.created));
      nextSeen.set(c.id, new Set(tracked.map(m => m.id)));
      const kind = c.attendance_eligible===false?null:c.status === 'open' && !c.assigned_to ? 'queue' : c.status === 'open' && c.assigned_to === snapshot.user.id ? 'mine' : c.status==='open'&&c.assigned_to?'assigned':null;
      if (fresh.length && kind) changes.push({conversation: c.id, kind, count: fresh.length, message: fresh.at(-1), name: c.name, account: c.account, owner:c.assignee_name||''});
    }
    seen = nextSeen;
    since = Number(snapshot.server_time) || Date.now();
    return changes;
  }
  return {observe, reset};
}

export function attendanceStatus(conversation){
 if(conversation.status==='resolved')return 'resolved';
 if(conversation.status==='open')return conversation.assigned_to?'open':conversation.attendance_eligible===false?'interaction':'queue';
 return conversation.status;
}
export function filterAttendanceConversations(snapshot,{scope='all',status='all',owner=''}={}){
 return snapshot.conversations.filter(c=>{
  const inScope=scope==='all'||scope==='mine'&&c.assigned_to===snapshot.user.id||scope==='queue'&&attendanceStatus(c)==='queue'||scope==='interactions'&&c.attendance_eligible===false;
  const matchesStatus=status==='all'||(scope==='interactions'&&status==='open'?c.status==='open':attendanceStatus(c)===status);
  const matchesOwner=scope!=='all'||snapshot.user.role!=='admin'||!owner||c.assigned_to===owner;
  return inScope&&matchesStatus&&matchesOwner;
 });
}
