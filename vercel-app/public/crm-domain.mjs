export const STAGES = [['new','Novo contato'],['qualified','Qualificado'],['proposal','Proposta'],['scheduled','Agendado'],['attended','Atendimento realizado'],['won','Venda'],['lost','Perdido']];
import {metaMediaUrl} from './meta-media.js';
export const SOURCES = { paid:'Campanha paga', organic:'Orgânico', unknown:'Não identificada' };
export const realOpportunity=o=>o.mode==='live'&&!String(o.customer||'').startsWith('demo-');

const text = (v,max=300) => typeof v==='string' ? v.slice(0,max) : '';
export function referralTouch(referral) {
  if (!referral || typeof referral!=='object' || Array.isArray(referral)) return null;
  const r={};
  for(const key of ['source_type','source_id','source_url','headline','body','ad_id','ctwa_clid','ref','source','type']) {
    if(typeof referral[key]==='string')r[key]=text(referral[key],key==='body'?2000:600);
  }
  const ad=text(r.ad_id || (r.source_type==='ad'?r.source_id:''));
  for(const key of ['image_url','video_url','thumbnail_url'])if(referral[key])r[key]=metaMediaUrl(referral[key]);
  if(referral.ads_context_data&&typeof referral.ads_context_data==='object'){
    const context=referral.ads_context_data;
    r.ads_context_data={ad_title:text(context.ad_title),photo_url:metaMediaUrl(context.photo_url),video_url:metaMediaUrl(context.video_url)};
  }
  const paid=!!ad || r.source_type==='ad' || r.source==='ADS' || !!r.ctwa_clid;
  return { source:paid?'paid':r.source_type==='post'?'organic':'unknown', evidence:'webhook', ad_id:ad, referral:r };
}

export function cents(value) {
  const s=String(value??'').replace(',','.');
  if(!/^\d{1,10}(\.\d{1,2})?$/.test(s))throw Error('Valor inválido; use até duas casas decimais.');
  const [whole,dec='']=s.split('.');
  const result=Number(whole)*100+Number(dec.padEnd(2,'0'));
  if(!Number.isSafeInteger(result))throw Error('Valor fora do limite.');
  return result;
}

export function selectedTouch(opportunity, model='first') {
  const touches=[...(opportunity.touches||[])].sort((a,b)=>a.created-b.created || String(a.id).localeCompare(String(b.id)));
  const firstSale=(opportunity.conversions||[]).filter(e=>e.kind==='sale'&&!e.voided).sort((a,b)=>a.occurred-b.occurred)[0];
  if(model==='last_paid'&&firstSale?.attribution?.last_paid)return firstSale.attribution.last_paid;
  const correction=touches.filter(t=>t.evidence==='manual'&&t.referral?.correct_first).at(-1);
  return (model==='last_paid'?touches.filter(t=>t.source==='paid').at(-1):correction)||touches[0]||{source:'unknown',evidence:'legacy',ad_id:''};
}

const median=xs=>{if(!xs.length)return null;xs.sort((a,b)=>a-b);const n=xs.length;return n%2?xs[(n-1)/2]:(xs[n/2-1]+xs[n/2])/2;};
export function summarize(opportunities, conversions, messages, model='first', grouping='campaign') {
  const groups=new Map(), operators=new Map();
  const bucket=key=>{if(!groups.has(key))groups.set(key,{key,leads:0,qualified:0,appointments:0,attendances:0,sales:0,clients:new Set(),revenue_cents:0,times:[]});return groups.get(key);};
  const operator=(key,name)=>{key||='unassigned';if(!operators.has(key))operators.set(key,{key,name:name||'Sem responsável',assigned:0,replies:0,appointments:0,attendances:0,sales:0,revenue_cents:0,response_times:[]});return operators.get(key);};
  for(const o of opportunities){
    const touch=selectedTouch(o,model),ad=o.ad||{};
    const key=grouping==='creative'?(ad.creative?.id?((ad.creative.name||'Criativo')+' · '+ad.creative.id):'Criativo não identificado'):grouping==='ad'?(touch.ad_id?((ad.ad_name?ad.ad_name+' · ':'')+touch.ad_id):SOURCES[touch.source]):grouping==='source'?SOURCES[touch.source]:grouping==='adset'?(touch.ad_id?((ad.adset_name||'Conjunto não identificado')+(ad.adset_id?' · '+ad.adset_id:'')):SOURCES[touch.source]):(touch.ad_id?((ad.campaign_name||'Campanha não identificada')+(ad.campaign_id?' · '+ad.campaign_id:'')):SOURCES[touch.source]);
    const g=bucket(key);g.leads++;if(o.stage!=='new'&&o.stage!=='lost')g.qualified++;
    operator(o.owner,o.owner_name).assigned++;
    const events=conversions.filter(e=>e.opportunity===o.id&&!e.voided);
    for(const [kind,field] of [['appointment','appointments'],['attendance','attendances'],['sale','sales']]) {
      const matching=events.filter(e=>e.kind===kind);if(matching.length)g[field]++;
    }
    const sales=events.filter(e=>e.kind==='sale');
    if(sales.length){g.clients.add(o.contact);g.times.push(Math.max(0,Math.min(...sales.map(e=>e.occurred))-o.first_contact));}
    for(const e of events){const p=operator(e.actor,e.actor_name);p[{appointment:'appointments',attendance:'attendances',sale:'sales'}[e.kind]]++;if(e.kind==='sale'){g.revenue_cents+=e.amount_cents;p.revenue_cents+=e.amount_cents;}}
    const replies=messages.filter(m=>m.conversation===o.conversation&&m.direction==='out'&&m.state==='sent'&&m.operator_id).sort((a,b)=>a.created-b.created);
    for(const m of replies)operator(m.operator_id,m.operator_name).replies++;
    const firstInbound=messages.filter(m=>m.conversation===o.conversation&&m.direction==='in').sort((a,b)=>a.created-b.created)[0];
    const firstReply=messages.filter(m=>m.conversation===o.conversation&&m.direction==='out'&&m.state==='sent').sort((a,b)=>a.created-b.created)[0];
    if(firstInbound&&firstReply?.operator_id)operator(firstReply.operator_id,firstReply.operator_name).response_times.push(Math.max(0,firstReply.created-firstInbound.created));
  }
  return { groups:[...groups.values()].map(g=>({...g,clients:g.clients.size,conversion_rate:g.leads?g.sales/g.leads:0,median_conversion_ms:median(g.times),times:undefined})).sort((a,b)=>b.revenue_cents-a.revenue_cents||b.leads-a.leads),operators:[...operators.values()].map(p=>({...p,median_response_ms:median(p.response_times),response_times:undefined})) };
}

