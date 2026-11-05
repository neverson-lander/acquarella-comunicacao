import {instagramMessageType} from './instagram-attendance.mjs';
// Run within a caller-owned transaction; original messages and attendance history stay intact.
export async function repairInstagramAttendance(db,tenant,open){
 const accounts=(await db.query("select * from accounts where tenant=$1 and channel='instagram'",[tenant])).rows;
 const originals=new Map();
 for(const {payload} of (await db.query('select payload from events where tenant=$1 order by created',[tenant])).rows){
  for(const entry of payload.entry||[]){
   const matching=accounts.filter(a=>[String(a.external),...(open(a.secret).instagramIds||[])].includes(String(entry.id)));
   for(const event of [...(entry.messaging||[]),...(entry.changes||[]).filter(c=>c.field==='messages').map(c=>c.value||{})]){
    if(!event.message?.mid||event.message.is_echo||event.message.is_deleted||!event.sender?.id)continue;
    for(const a of matching)originals.set(a.id+':'+event.message.mid,{customer:String(event.sender.id),type:instagramMessageType(event.message)});
   }
  }
 }
 let ignoredMessages=0,interactions=0;const changed=[];
 for(const a of accounts){
  const conversations=(await db.query('select * from conversations where tenant=$1 and account=$2 order by id for update',[tenant,a.id])).rows;
  for(const c of conversations){
   const messages=(await db.query('select * from messages where conversation=$1 order by created,id',[c.id])).rows;
   const history=(await db.query('select * from attendance_history where conversation=$1 order by created,id',[c.id])).rows;
   let started=false,hi=0;
   for(const m of messages){
    while(hi<history.length&&Number(history[hi].created)<=Number(m.created)){
     const h=history[hi++];if(h.action==='Atendimento finalizado'||h.action.startsWith('Atendimento encerrado em massa'))started=false;else if(h.actor)started=true;
    }
    if(m.direction!=='in'){if(m.direction==='out'&&m.operator_id)started=true;continue;}
    const original=originals.get(m.external),type=original?.customer===c.customer?original.type:m.kind==='shared'?'social':null;
    if(type==='text'||!type){started=true;continue;}
    if(type==='social'||type==='media'&&!started){
     if(m.attendance_relevant!==false){await db.query('update messages set attendance_relevant=false where id=$1',[m.id]);ignoredMessages++;}
    }
   }
   const remaining=(await db.query("select min(created) as first from messages where conversation=$1 and direction='in' and attendance_relevant and kind<>'reaction'",[c.id])).rows[0].first;
   if(remaining===null&&!history.some(h=>h.actor)&&!messages.some(m=>m.direction==='out')&&!c.assigned_to){
    const protectedRow=(await db.query('select exists(select 1 from cashbarber_bookings where conversation=$1) or exists(select 1 from crm_events e join crm_opportunities o on o.id=e.opportunity where o.conversation=$1) as protected',[c.id])).rows[0];
    if(!protectedRow.protected&&c.attendance_eligible!==false){await db.query('update conversations set attendance_eligible=false where id=$1',[c.id]);interactions++;changed.push({id:c.id,name:c.name});}
   }else if(remaining!==null&&!history.some(h=>h.actor)){
    await db.query('update crm_opportunities set first_contact=$1 where conversation=$2 and first_contact<$1',[remaining,c.id]);
   }
  }
 }
 return {ignoredMessages,interactions,changed};
}
