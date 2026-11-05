const text=(v,max)=>typeof v==='string'?v.slice(0,max):'';
export function extractReferral(message){
  const m=message||{},contexts=[];
  for(const v of Object.values(m)){if(v&&typeof v==='object'){if(v.contextInfo)contexts.push(v.contextInfo);if(v.externalAdReply)contexts.push(v);}}
  const context=contexts.find(c=>c.externalAdReply),ad=context?.externalAdReply;if(!ad)return null;
  const source_type=text(ad.sourceType,40),source_id=text(ad.sourceId,40),ctwa_clid=text(ad.ctwaClid,600);
  if(!['ad','post'].includes(source_type)&&!ctwa_clid)return null;
  const r={source_type,source_id,source_url:text(ad.sourceUrl,600),headline:text(ad.title,600),body:text(ad.body,2000),source_app:text(ad.sourceApp||context.entryPointConversionApp,40)};
  if(source_type==='ad'&&/^\d{1,40}$/.test(source_id))r.ad_id=source_id;
  if(ctwa_clid)r.ctwa_clid=ctwa_clid;
  if(ad.thumbnailUrl)r.thumbnail_url=text(ad.thumbnailUrl,2000);
  if(ad.originalImageUrl)r.image_url=text(ad.originalImageUrl,2000);
  return r;
}
