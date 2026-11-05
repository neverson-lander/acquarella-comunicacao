import {normalizeServiceHours,withinServiceHours} from './service-hours-policy.mjs';
import {bulkClosedConversations} from './metrics-scope.mjs';

const DAY=86400000,valid=value=>Number.isSafeInteger(Number(value))&&Number(value)>0&&Number(value)<=8640000000000000;
const minutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const dateKey=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'});

// Build actual UTC windows from the channel's civil calendar, including split
// shifts, midnight crossings, and timezone changes. Reuse daily windows across
// messages instead of stepping through individual minutes.
export function createServiceClock(input){
  let hours;try{hours=normalizeServiceHours(input);}catch{return null;}
  if(!hours.enabled)return null;
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:hours.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}),cache=new Map();
  const civil=stamp=>{const p=Object.fromEntries(formatter.formatToParts(stamp).map(v=>[v.type,v.value]));return Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));};
  const instant=(day,minute,end)=>{
    const target=day*DAY+minute*60000;
    const offsets=new Set([-36,0,36].map(h=>{const sample=target+h*3600000;return civil(sample)-sample;}));
    const candidates=[...offsets].map(offset=>target-offset),matches=candidates.filter(value=>civil(value)===target);
    return matches.length?(end?Math.max(...matches):Math.min(...matches)):Math.max(...candidates);
  };
  const windows=day=>{
    if(!cache.has(day))cache.set(day,hours.days[new Date(day*DAY).getUTCDay()].map(slot=>{
      const a=minutes(slot.start),b=minutes(slot.end);
      return [instant(day,a,false),instant(day+(b<a?1:0),b,true)];
    }));
    return cache.get(day);
  };
  return (start,end)=>{
    if(!valid(start)||!valid(end)||Number(end)<Number(start))return null;
    start=Number(start);end=Number(end);let total=0,lastEnd=-Infinity;const intervals=[];
    const first=Math.floor(civil(start)/DAY)-1,last=Math.floor(civil(end)/DAY);
    for(let day=first;day<=last;day++)for(const [a,b] of windows(day))if(b>start&&a<end)intervals.push([Math.max(start,a),Math.min(end,b)]);
    for(const [a,b] of intervals.sort((a,b)=>a[0]-b[0])){total+=Math.max(0,b-Math.max(a,lastEnd));lastEnd=Math.max(lastEnd,b);}
    return total;
  };
}

export function buildMessageTimingMetrics(state,filters={},now=Number(state.clock_time)||Date.now()){
  const {from='',to='',channel='',owner='',delay='all',opening='all'}=filters;
  const deliveryLimit=Number.isFinite(Number(filters.deliverySeconds))&&Number(filters.deliverySeconds)>=0?Number(filters.deliverySeconds)*1000:30000;
  const openingLimit=Number.isFinite(Number(filters.openingMinutes))&&Number(filters.openingMinutes)>=0?Number(filters.openingMinutes)*60000:300000;
  const excluded=bulkClosedConversations(state.crm,state.conversations),accounts=new Map(state.accounts.map(a=>[a.id,a])),clocks=new Map(),records=[];
  const difference=(a,b)=>valid(a)&&valid(b)&&Number(b)>=Number(a)?Number(b)-Number(a):null;
  for(const c of state.conversations){
    const account=accounts.get(c.account);
    if(!account||account.mode==='demo'||excluded.has(c.id)||c.attendance_eligible===false||(channel&&account.channel!==channel)||(owner&&c.assigned_to!==owner))continue;
    if(!clocks.has(account.id))clocks.set(account.id,createServiceClock(account.service_hours));
    const work=clocks.get(account.id);
    for(const m of c.messages||[]){
      if(m.direction!=='in'||m.attendance_relevant===false||m.kind==='reaction'||!valid(m.created))continue;
      const sent=Number(m.created),day=dateKey.format(sent);
      if(sent>now||(from&&day<from)||(to&&day>to))continue;
      const received=valid(m.received_at)?Number(m.received_at):null,viewed=valid(m.first_viewed_at)?Number(m.first_viewed_at):null;
      const future=!!(received&&received>now+300000||viewed&&viewed>now+300000);
      const delivery=future?null:difference(sent,received),elapsed=future?null:difference(received,viewed),total=future?null:difference(sent,viewed);
      let openingStatus=viewed?(work?'inside':'unconfigured'):'pending';
      if(viewed&&work)openingStatus=withinServiceHours(account.service_hours,viewed)?'inside':'outside';
      const business=work&&elapsed!==null?work(received,viewed):null;
      const pending=work&&!viewed&&received&&received<=now?work(received,now):null;
      const lateDelivery=delivery!==null&&delivery>deliveryLimit,lateOpening=(business??pending)!==null&&(business??pending)>openingLimit;
      const invalid=future||!!(received&&received<sent||viewed&&received&&viewed<received||viewed&&viewed<sent);
      records.push({id:m.id,conversation:c.id,customer:c.name,contact:c.customer,account:account.name,channel:account.channel,sent,received,viewed,delivery,elapsed:invalid?null:elapsed,business:invalid?null:business,total:invalid?null:total,pending,openingStatus,scheduleKnown:!!work,invalid,lateDelivery,lateOpening:!invalid&&lateOpening});
    }
  }
  const rows=records.filter(r=>(opening==='all'||r.openingStatus===opening)&&(delay==='all'||delay==='delivery'&&r.lateDelivery||delay==='opening'&&r.lateOpening||delay==='either'&&(r.lateDelivery||r.lateOpening)||delay==='both'&&r.lateDelivery&&r.lateOpening));
  rows.sort((a,b)=>{const score=r=>delay==='delivery'?(r.delivery??-1):Math.max(r.business??r.pending??-1,r.delivery??-1);return score(b)-score(a)||b.sent-a.sent||a.id.localeCompare(b.id);});
  const aggregate=field=>{const values=rows.map(r=>r[field]).filter(value=>value!==null);return {mean:mean(values),samples:values.length};};
  return {rows,available:records.length,delivery:aggregate('delivery'),opening:aggregate('business'),elapsed:aggregate('elapsed'),total:aggregate('total'),pending:rows.filter(r=>!r.viewed).length,outside:rows.filter(r=>r.openingStatus==='outside').length,unconfigured:rows.filter(r=>!r.scheduleKnown).length,invalid:rows.filter(r=>r.invalid).length,deliveryLimit,openingLimit};
}
