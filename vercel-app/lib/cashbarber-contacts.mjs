import {normalizeContactPhone,contactPhoneKey} from '../public/contact-domain.mjs';
import {cashError,externalId} from './cashbarber-domain.mjs';

export function createCashbarberContacts({pool,client,audit}){
 async function save(db,user,account,customer){
  const clientId=externalId(customer.id),name=String(customer.name||'').trim();
  if(!name||name.length>200)throw cashError('Nome vazio ou maior que 200 caracteres.');
  const phone=normalizeContactPhone(customer.phone),key=contactPhoneKey(phone),rawEmail=String(customer.email||'').trim();
  const email=rawEmail.length<=200&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)?rawEmail:'';
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`${user.tenant}:contact:${account}:${key}`]);
  let old=(await db.query('select c.* from cashbarber_contact_links l join crm_contacts c on c.id=l.contact and c.tenant=l.tenant where l.tenant=$1 and l.account=$2 and l.client_id=$3',[user.tenant,account,clientId])).rows[0];
  if(old?.account!==account)old=undefined;
  old??=(await db.query('select * from crm_contacts where tenant=$1 and account=$2 and phone_key=$3',[user.tenant,account,key])).rows[0];
  let contact=old?.id;
  if(old){
   // Never erase a manual name, tags, notes, inactive status or campaign preference.
   if(!old.email&&email)await db.query('update crm_contacts set email=$1 where id=$2 and tenant=$3',[email,old.id,user.tenant]);
  }else contact=(await db.query('insert into crm_contacts(tenant,account,name,phone,email,active,name_manual,created) values($1,$2,$3,$4,$5,$6,false,$7) returning id',[user.tenant,account,name,phone,email,customer.active!==false,Date.now()])).rows[0].id;
  await db.query('insert into cashbarber_contact_links(tenant,account,client_id,contact,updated) values($1,$2,$3,$4,$5) on conflict(tenant,account,client_id) do update set contact=excluded.contact,updated=excluded.updated',[user.tenant,account,clientId,contact,Date.now()]);
  return {created:!old,contact};
 }
 async function saveCustomers(user,account,customers){
  const db=await pool.connect(),result={created:0,existing:0,skipped:[]};
  try{
   await db.query('begin');await db.query("select set_config('app.contact_actor',$1,true)",[JSON.stringify({id:user.id,name:user.name})]);
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['cashbarber-import:'+user.tenant+':'+account]);
   const a=(await db.query('select * from accounts where id=$1 and tenant=$2 for share',[account,user.tenant])).rows[0];
   if(!a||a.enabled===false||a.deleted_at)throw cashError('Canal de destino indisponível.',409);
   for(const customer of customers){
    // Validate before SQL so a malformed source record does not abort the batch.
    try{externalId(customer.id);normalizeContactPhone(customer.phone);if(!customer.name?.trim()||customer.name.length>200)throw cashError('Nome vazio ou maior que 200 caracteres.');}
    catch(error){result.skipped.push({id:String(customer.id||''),reason:error.message});continue;}
    const row=await save(db,user,account,customer);result[row.created?'created':'existing']++;
   }
   await db.query('commit');return result;
  }catch(error){await db.query('rollback');throw error;}finally{db.release();}
 }
 async function importPage(user,input){
  if(user.role!=='admin')throw cashError('Somente administradores podem importar a base CashBarber.',403);
  if(!/^[a-f0-9-]{36}$/i.test(input.account||''))throw cashError('Selecione o canal de destino.');
  const a=(await pool.query('select * from accounts where id=$1 and tenant=$2',[input.account,user.tenant])).rows[0];
  if(!a||a.enabled===false||a.deleted_at)throw cashError('Canal de destino indisponível.',403);
  const page=input.page??0;if(!Number.isInteger(page)||page<0||page>999)throw cashError('Página inválida.');
  const batch=await client.call(user.tenant,'customer-page',{page});
  if(batch.page!==page||!Array.isArray(batch.clients)||batch.clients.length>100||!Number.isInteger(batch.lastPage)||batch.lastPage<1||batch.lastPage>1000||!Number.isInteger(batch.total))throw cashError('Lote de clientes inválido.',502);
  const result=await saveCustomers(user,a.id,batch.clients);
  await audit(user.tenant,`Importação CashBarber, canal ${a.name}, página ${page+1}: ${result.created} novos, ${result.existing} existentes, ${result.skipped.length} ignorados. Operador: ${user.name}.`);
  return {...result,page,lastPage:batch.lastPage,total:batch.total,processed:batch.clients.length};
 }
 return {importPage,saveCustomers};
}
