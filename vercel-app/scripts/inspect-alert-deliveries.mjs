import {pool} from '../lib/database.mjs';
const recipients=(await pool.query(`select right(j.recipient,4) as phone_suffix,j.state,j.error,count(*)::int as attempts,
 max(j.created) as last_attempt,a.name as channel
 from jobs j left join accounts a on a.id=j.alert_source
 where j.kind='waiting_alert' and j.created>$1
 group by j.recipient,j.state,j.error,a.name order by max(j.created) desc limit 30`,[Date.now()-86400000])).rows;
console.log('ALERT_DELIVERY_DIAGNOSTICS',JSON.stringify(recipients));
const windows=(await pool.query('select right(phone,4) as phone_suffix,seen,account from bridge_windows order by seen desc limit 20')).rows;
console.log('ALERT_WINDOW_DIAGNOSTICS',JSON.stringify(windows));
const failures=(await pool.query(`select created, payload->'entry' as entries from events where created>$1 and payload->>'object'='whatsapp_business_account' order by created desc limit 100`,[Date.now()-86400000])).rows.flatMap(event=>(event.entries||[]).flatMap(entry=>(entry.changes||[]).flatMap(change=>(change.value?.statuses||[]).filter(status=>status.status==='failed').map(status=>({created:event.created,recipient_suffix:String(status.recipient_id||'').slice(-4),errors:status.errors})))));
console.log('ALERT_META_FAILURES',JSON.stringify(failures));
