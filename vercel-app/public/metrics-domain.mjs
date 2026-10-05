import {realOpportunity,selectedTouch,summarize} from './crm-domain.mjs';
export const dayKey=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(t);
const median=values=>{const xs=[...values].sort((a,b)=>a-b),n=xs.length;return n?(xs[Math.floor(n/2)]+xs[Math.ceil(n/2)-1])/2:null;};
export function buildMetrics(state,{from='',to='',channel='',owner='',grouping='campaign'}={},now=Date.now()){
  const start=from?new Date(from+'T00:00:00-03:00').getTime():0,end=Math.min(now,to?new Date(to+'T23:59:59.999-03:00').getTime():now);
  const inside=t=>Number.isFinite(Number(t))&&t>=start&&t<=end;
  const crm=state.crm,opportunities=crm.opportunities.filter(o=>realOpportunity(o)&&(!channel||o.channel===channel)&&(!owner||o.owner===owner));
  const byConversation=new Map(opportunities.map(o=>[o.conversation,o])),ids=new Set(opportunities.map(o=>o.id));
  const conversations=state.conversations.filter(c=>byConversation.has(c.id));
  const history=(crm.attendance_history||[]).filter(h=>byConversation.has(h.conversation)).sort((a,b)=>a.created-b.created||String(a.id).localeCompare(String(b.id)));
  const events=crm.events.filter(e=>ids.has(e.opportunity)&&!e.voided&&inside(e.occurred));
  const rows=new Map(),channels=new Map(),days=new Map(),services=new Map();
  const newRow=(id,name)=>({id,name,open:0,queue:0,new:0,closed:0,reopened:0,replies:0,failed:0,scheduled:0,appointments:0,attendances:0,sales:0,revenue:0,response:[],resolution:[],waiting:0});
  const operator=(id,name)=>{const key=id||'unknown';if(!rows.has(key))rows.set(key,newRow(key,name||crm.team.find(u=>u.id===id)?.name||'Operador não identificado'));return rows.get(key);};
  const channelRow=c=>{if(!channels.has(c))channels.set(c,newRow(c,{whatsapp:'WhatsApp',instagram:'Instagram',messenger:'Messenger'}[c]||c));return channels.get(c);};
  const day=t=>{const key=dayKey(t);if(!days.has(key))days.set(key,{day:key,new:0,closed:0,replies:0});return days.get(key);};
  const totals=newRow('total','Total'),cycleClaims=new Map();let confirmations=0;
  for(const h of history){
    const ch=channelRow(byConversation.get(h.conversation).channel);
    if(h.action==='Atendimento assumido'&&!cycleClaims.has(h.conversation))cycleClaims.set(h.conversation,h.created);
    if(h.action==='Atendimento finalizado'){
      if(inside(h.created)){
        const p=operator(h.actor,h.actor_name);totals.closed++;p.closed++;ch.closed++;day(h.created).closed++;
        const claim=cycleClaims.get(h.conversation);
        if(claim!=null&&claim<=h.created){const duration=h.created-claim;totals.resolution.push(duration);p.resolution.push(duration);ch.resolution.push(duration);}
        if(h.scheduling){confirmations++;if(h.scheduling.had_scheduling){totals.scheduled++;p.scheduled++;ch.scheduled++;for(const s of h.scheduling.services){if(!services.has(s.id))services.set(s.id,{id:s.id,name:s.name,count:0});services.get(s.id).count++;}}}
      }
      cycleClaims.delete(h.conversation);
    }else if(h.action.includes('Reaberto')||h.action==='Atendimento reaberto'||h.action.startsWith('Nova mensagem após encerramento')){
      cycleClaims.delete(h.conversation);
      if(inside(h.created)){totals.reopened++;ch.reopened++;operator(h.actor||(h.action.startsWith('Nova mensagem')?'system':null),h.actor_name||(!h.actor?'Sistema':null)).reopened++;}
    }
  }
  for(const o of opportunities){const ch=channelRow(o.channel);if(inside(o.first_contact)){totals.new++;ch.new++;day(o.first_contact).new++;}}
  for(const c of conversations){
    const ch=channelRow(byConversation.get(c.id).channel),messages=[...c.messages].sort((a,b)=>a.created-b.created);
    if(c.status==='open'){
      totals.open++;ch.open++;
      if(!c.assigned_to){totals.queue++;ch.queue++;}else operator(c.assigned_to,c.assignee_name).open++;
      const inbound=messages.filter(m=>m.direction==='in').at(-1),reply=messages.filter(m=>m.direction==='out'&&m.state==='sent').at(-1);
      if(inbound&&(!reply||inbound.created>reply.created)&&now-inbound.created>=1800000){totals.waiting++;ch.waiting++;if(c.assigned_to)operator(c.assigned_to,c.assignee_name).waiting++;}
    }
    const firstInbound=messages.find(m=>m.direction==='in'),firstReply=messages.find(m=>m.direction==='out'&&m.state==='sent');
    if(firstInbound&&firstReply&&firstReply.created>=firstInbound.created&&inside(firstReply.created)){
      const duration=firstReply.created-firstInbound.created;totals.response.push(duration);ch.response.push(duration);
      if(firstReply.operator_id)operator(firstReply.operator_id,firstReply.operator_name).response.push(duration);
    }
    for(const m of messages){if(m.direction!=='out'||!inside(m.created))continue;
      if(m.state==='sent'){totals.replies++;ch.replies++;operator(m.operator_id,m.operator_name).replies++;day(m.created).replies++;}
      if(m.state==='failed'){totals.failed++;ch.failed++;operator(m.operator_id,m.operator_name).failed++;}
    }
  }
  for(const e of events){const o=opportunities.find(o=>o.id===e.opportunity),ch=channelRow(o.channel),p=operator(e.actor,e.actor_name),field={appointment:'appointments',attendance:'attendances',sale:'sales'}[e.kind];if(!field)continue;totals[field]++;ch[field]++;p[field]++;if(e.kind==='sale'){totals.revenue+=Number(e.amount_cents);ch.revenue+=Number(e.amount_cents);p.revenue+=Number(e.amount_cents);}}
  const enrich=r=>({...r,response:median(r.response),responseSamples:r.response.length,resolution:median(r.resolution),resolutionSamples:r.resolution.length});
  const cohort=opportunities.filter(o=>inside(o.first_contact)).map(o=>{const touches=crm.touches.filter(t=>t.opportunity===o.id),conversions=crm.events.filter(e=>e.opportunity===o.id&&!e.voided&&e.occurred<=now),touch=selectedTouch({touches,conversions});return {...o,touches,conversions,ad:{...crm.ads.find(a=>a.ad_id===touch.ad_id),...touch.meta_snapshot}};});
  const campaigns=summarize(cohort,cohort.flatMap(o=>o.conversions),[],'first',grouping).groups;
  const scheduledConversations=new Set(history.filter(h=>h.action==='Atendimento finalizado'&&h.created<=now&&h.scheduling?.had_scheduling).map(h=>h.conversation));
  for(const group of campaigns){group.scheduled_leads=cohort.filter(o=>scheduledConversations.has(o.conversation)&&summarize([o],[],[],'first',grouping).groups[0].key===group.key).length;}
  return {totals:enrich(totals),confirmations,schedulingRate:confirmations?totals.scheduled/confirmations:null,ticket:totals.sales?totals.revenue/totals.sales:null,operators:[...rows.values()].map(enrich).sort((a,b)=>b.closed-a.closed||b.replies-a.replies),channels:[...channels.values()].map(enrich),days:[...days.values()].sort((a,b)=>a.day.localeCompare(b.day)),services:[...services.values()].sort((a,b)=>b.count-a.count),campaigns};
}
