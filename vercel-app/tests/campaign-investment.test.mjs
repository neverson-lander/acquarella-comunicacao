import test from 'node:test';
import assert from 'node:assert/strict';
import {createCampaignInvestment,metaMoney} from '../lib/campaign-investment.mjs';
import {investmentComparison} from '../public/campaign-investment.mjs';
const now=Date.parse('2026-11-04T12:00:00-03:00'),input={from:'2026-10-01',to:'2026-11-04'},user={tenant:'tenant',role:'admin'};
function setup(){
 const calls=[],queries=[];let bad=false;
 const pool={query:async(sql,args)=>{queries.push({sql,args});assert.equal(args[0],'tenant');if(sql.includes('crm_settings'))return {rows:[{secret:'encrypted'}]};if(sql.includes('min(o.first_contact)'))return {rows:[{first:Date.parse('2026-10-19T12:00:00-03:00')}]};return {rows:[{ad_id:'11',campaign_id:'101'}]};}};
 const service=createCampaignInvestment({pool,open:()=>({version:'v26.0',token:'private-token'}),now:()=>now,fetcher:async(url,options)=>{
  calls.push({url,options});const u=new URL(url);assert.equal(u.origin,'https://graph.facebook.com');assert.ok(!u.search.includes('private-token'));assert.equal(options.headers.Authorization,'Bearer private-token');
  if(bad)return Response.json({error:{message:'secret provider response',code:190}},{status:400});
  if(u.pathname.endsWith('/11'))return Response.json({account_id:'99'});
  if(u.pathname.endsWith('/act_99'))return Response.json({currency:'BRL',timezone_name:'America/Sao_Paulo'});
  assert.equal(u.searchParams.get('level'),'campaign');assert.ok(u.searchParams.has('time_range'));
  return u.searchParams.has('after')?Response.json({data:[{campaign_id:'102',campaign_name:'Sem contatos na central',spend:'0.20',account_currency:'BRL'}]}):Response.json({data:[{campaign_id:'101',campaign_name:'Campanha 1',spend:'10.10',account_currency:'BRL'}],paging:{next:'https://unsafe.example/?access_token=secret',cursors:{after:'cursor'}}});
 }});
 return {service,calls,queries,setBad:()=>{bad=true;}};
}
test('spend comes from tenant-linked accounts, includes no-lead campaigns, paginates safely and caches the exact period',async()=>{
 const f=setup(),r=await f.service.report(user,input);assert.equal(r.campaigns.length,2);assert.equal(r.campaigns.reduce((n,c)=>n+c.spend_cents,0),1030);assert.deepEqual(r.known_campaign_ids,['101']);assert.equal(f.calls.length,4);assert.ok(f.calls.every(c=>!c.url.includes('unsafe.example')));
 const cached=await f.service.report(user,input);assert.equal(cached.cached,true);assert.equal(f.calls.length,4);
 const other=await f.service.report(user,{...input,from:'2026-10-02'});assert.equal(other.from,'2026-10-02');assert.equal(f.calls.length,8);
});
test('admin permission, dates, implicit history start and provider failure never become a fabricated zero expense',async()=>{
 const f=setup();await assert.rejects(f.service.report({...user,role:'receptionist'},input),e=>e.status===403);assert.equal(f.queries.length,0);
 await assert.rejects(f.service.report(user,{from:'2026-02-30',to:input.to}),/período/);await assert.rejects(f.service.report(user,{from:input.to,to:'2027-01-01'}),/período/);
 const r=await f.service.report(user,{});assert.equal(r.from,'2026-10-19');assert.equal(r.to,'2026-11-04');
 f.setBad();await assert.rejects(f.service.report(user,{...input,from:'2026-10-03'}),e=>e.status===502&&!e.message.includes('secret'));
});
test('monetary math uses integer cents and separates the direct and acquisition perspectives',()=>{
 assert.equal(metaMoney('1985.41'),198541);assert.equal(metaMoney('0'),0);assert.throws(()=>metaMoney('1.123'));assert.throws(()=>metaMoney('-1'));
 const analysis={groups:[{id:'101',name:'Campanha',attendances:10,scheduled:2,services:3,value_cents:10000,unknown_value:1},{id:'unmapped',name:'Sem ID',attendances:1,scheduled:1,services:1,value_cents:99999,unknown_value:0}],acquisition:[{campaign:'101',campaign_name:'Campanha',converted:true,services:[{name:'Serviço'}],value_cents:15000,unknown_value:0}]};
 const spend={campaigns:[{id:'101',name:'Campanha',spend_cents:2500},{id:'102',name:'Sem contatos',spend_cents:500}],known_campaign_ids:['101']};
 const direct=investmentComparison(analysis,spend),acquired=investmentComparison(analysis,spend,'acquisition');
 assert.equal(direct.rows.find(r=>r.id==='101').ratio,4);assert.equal(direct.rows.find(r=>r.id==='101').cost_per_scheduled,1250);assert.equal(direct.totals.spend_cents,3000);assert.equal(direct.totals.value_cents,10000);assert.equal(direct.totals.unmapped,1);assert.equal(direct.rows.find(r=>r.id==='unmapped').spend_cents,null);assert.equal(acquired.totals.value_cents,15000);assert.equal(acquired.totals.spend_cents,3000);
 const zero=investmentComparison({groups:[analysis.groups[0]],acquisition:[]},{campaigns:[],known_campaign_ids:['101']});assert.equal(zero.rows[0].spend_cents,0);assert.equal(zero.rows[0].ratio,null);
});
