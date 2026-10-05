export async function registeredSource(db,tenant,input,{allowUnknown=false}={}){
  const fail=message=>{throw Object.assign(Error(message),{status:400});};
  if(!['paid','organic',...(allowUnknown?['unknown']:[])].includes(input.source))fail('Informe a origem do contato antes de encerrar.');
  if(input.source!=='paid'){
    if(input.ad_id)fail('Anúncio requer origem de campanha paga.');
    return '';
  }
  if(typeof input.ad_id!=='string'||!/^\d{1,40}$/.test(input.ad_id))fail('Selecione um anúncio previamente cadastrado.');
  const ad=(await db.query('select ad_id from crm_ads where tenant=$1 and ad_id=$2',[tenant,input.ad_id])).rows[0];
  if(!ad)fail('Selecione um anúncio previamente cadastrado nesta empresa.');
  return ad.ad_id;
}
export async function sourceSnapshot(db,tenant,opportunity,aid){
  if(!aid)return {};
  const prior=(await db.query("select meta_snapshot from crm_touches where tenant=$1 and opportunity=$2 and ad_id=$3 and meta_snapshot<>'{}'::jsonb order by created,id limit 1",[tenant,opportunity,aid])).rows[0];
  if(prior)return prior.meta_snapshot;
  const ad=(await db.query('select * from crm_ads where tenant=$1 and ad_id=$2',[tenant,aid])).rows[0];
  if(!ad?.verified)return {};
  const {ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,creative,sync_checked}=ad;
  return {ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,creative,consulted_at:sync_checked,verified:true};
}
