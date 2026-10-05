import {metaMediaUrl} from '../public/meta-media.js';
const text=(value,max=200)=>typeof value==='string'?value.slice(0,max):'';
export function creativeDetails(value={}){
  const story=value.object_story_spec||{},content=story.link_data||story.video_data||story.photo_data||story.text_data||{};
  return {id:text(value.id,40),name:text(value.name),title:text(value.title||content.name),body:text(value.body||content.message,2000),video_id:text(value.video_id||content.video_id,40),image_url:metaMediaUrl(value.image_url),thumbnail_url:metaMediaUrl(value.thumbnail_url),post_id:text(value.effective_object_story_id,100),permalink:metaMediaUrl(value.instagram_permalink_url),dynamic:!!value.asset_feed_spec&&Object.keys(value.asset_feed_spec).length>0};
}
export function createMetaAttribution({pool,open,now=Date.now,fetcher=fetch}){
  async function syncAd(tenant,aid,{force=false}={}){
    if(typeof aid!=='string'||!/^\d{1,40}$/.test(aid))return {ok:false,error:'ID de anúncio inválido.'};
    const setting=(await pool.query('select secret from crm_settings where tenant=$1',[tenant])).rows[0];
    if(!setting)return {ok:false,error:'Configure a credencial Meta Ads com ads_read e acesso à conta de anúncios.'};
    const stamp=now();
    // A conditional update prevents duplicate webhook deliveries from flooding the Meta API.
    const claimed=await pool.query('update crm_ads set sync_checked=$1 where tenant=$2 and ad_id=$3 and ($4 or sync_checked<$5) returning ad_id',[stamp,tenant,aid,force,stamp-6*3600000]);
    if(!claimed.rows.length)return {ok:true,cached:true};
    try{
      const secret=open(setting.secret),version=/^v\d+\.0$/.test(secret.version)?secret.version:'v26.0';
      const fields='id,name,campaign{id,name},adset{id,name},creative{id,name,title,body,image_url,thumbnail_url,video_id,effective_object_story_id,instagram_permalink_url,object_story_spec,asset_feed_spec}';
      const response=await fetcher(`https://graph.facebook.com/${version}/${aid}?fields=${encodeURIComponent(fields)}`,{headers:{Authorization:`Bearer ${secret.token}`},signal:AbortSignal.timeout(4000)});
      const result=await response.json().catch(()=>({}));
      if(!response.ok||String(result.id)!==aid)throw Error('Consulta recusada pela Meta. Confira ads_read, validade da credencial e acesso ao anúncio.');
      const creative=creativeDetails(result.creative);
      await pool.query('update crm_ads set ad_name=$1,campaign_id=$2,campaign_name=$3,adset_id=$4,adset_name=$5,creative=$6,verified=true,sync_error=$7,updated=$8 where tenant=$9 and ad_id=$10',[text(result.name),text(result.campaign?.id,40),text(result.campaign?.name),text(result.adset?.id,40),text(result.adset?.name),JSON.stringify(creative),'',stamp,tenant,aid]);
      const snapshot={ad_id:aid,ad_name:text(result.name),campaign_id:text(result.campaign?.id,40),campaign_name:text(result.campaign?.name),adset_id:text(result.adset?.id,40),adset_name:text(result.adset?.name),creative,consulted_at:stamp,verified:true};
      await pool.query("update crm_touches set meta_snapshot=$1 where tenant=$2 and ad_id=$3 and meta_snapshot='{}'::jsonb",[JSON.stringify(snapshot),tenant,aid]);
      return {ok:true};
    }catch{
      const error='Consulta Meta pendente. Confira ads_read, validade da credencial e acesso ao anúncio; tente atualizar novamente.';
      await pool.query('update crm_ads set sync_error=$1 where tenant=$2 and ad_id=$3',[error,tenant,aid]);
      return {ok:false,error};
    }
  }
  async function syncPending(tenant){
    const ads=(await pool.query("select ad_id from crm_ads where tenant=$1 and (not verified or creative->>'id' is null or creative->>'id'='') order by sync_checked,updated limit 10",[tenant])).rows;
    const results=[];for(const ad of ads)results.push(await syncAd(tenant,ad.ad_id,{force:true}));
    return {ok:true,checked:results.length,updated:results.filter(r=>r.ok&&!r.cached).length,pending:results.filter(r=>!r.ok).length};
  }
  return {syncAd,syncPending};
}
