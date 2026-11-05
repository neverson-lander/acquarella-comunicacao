import {referralTouch} from './crm-domain.mjs';
import {sourceSnapshot} from './registered-source.mjs';

// A new inbound after closure starts its own attribution window. The old
// touches, manual corrections and conversion snapshots remain in the history.
export async function captureAttendanceSource(db,conversation,account,opportunity,message,refs){
 if(conversation.status!=='resolved')return;
 const closure=(await db.query(`select id,created from attendance_history where tenant=$1 and conversation=$2 and created<=$3
  and (action='Atendimento finalizado' or action like 'Atendimento encerrado em massa%') order by created desc,id desc limit 1`,[account.tenant,conversation.id,message.timestamp])).rows[0];
 if(!closure)return;
 const entry=refs.filter(r=>r.timestamp>=closure.created&&r.timestamp<=message.timestamp).find(r=>referralTouch(r.referral)?.source==='paid')||message;
 const touch=referralTouch(entry.referral)||{source:'organic',ad_id:'',referral:{}};
 const snapshot=await sourceSnapshot(db,account.tenant,opportunity.id,touch.ad_id);
 await db.query(`insert into crm_touches(tenant,opportunity,event_key,source,evidence,ad_id,referral,created,meta_snapshot)
  values($1,$2,$3,$4,'webhook',$5,$6,$7,$8) on conflict(opportunity,event_key) do nothing`,[account.tenant,opportunity.id,'attendance:'+closure.id,touch.source==='unknown'?'organic':touch.source,touch.ad_id,JSON.stringify({...touch.referral,attendance_start:closure.id}),entry.timestamp,JSON.stringify(snapshot)]);
}
