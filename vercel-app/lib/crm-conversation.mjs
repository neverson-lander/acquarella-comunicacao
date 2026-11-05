import {contactPhoneKey} from '../public/contact-domain.mjs';

// Use the caller's transaction so a failed closure cannot leave partial CRM data.
export async function ensureConversationCrm(db,conversation,account,timestamp){
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[account.id+':'+conversation.customer]);
  let o=(await db.query('select * from crm_opportunities where conversation=$1 and tenant=$2 for update',[conversation.id,account.tenant])).rows[0];
  if(o)return o;
  const phone=account.channel==='whatsapp'?conversation.customer:'',phoneKey=contactPhoneKey(phone);
  if(phoneKey)await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`${account.tenant}:contact:${account.id}:${phoneKey}`]);
  const contact=(phoneKey&&(await db.query('select id from crm_contacts where tenant=$1 and account=$2 and phone_key=$3',[account.tenant,account.id,phoneKey])).rows[0])||
    (await db.query('insert into crm_contacts(tenant,name,account,phone,created) values($1,$2,$3,$4,$5) returning id',[account.tenant,conversation.name,account.id,phone,timestamp])).rows[0];
  o=(await db.query('insert into crm_opportunities(tenant,conversation,contact,owner,first_contact,updated) values($1,$2,$3,$4,$5,$6) returning *',[account.tenant,conversation.id,contact.id,conversation.assigned_to||null,timestamp,conversation.updated])).rows[0];
  return o;
}
