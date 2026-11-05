import {cashError,minutes,clock} from '../vercel-app/lib/cashbarber-domain.mjs';
export function calendarDate(value){
  const date=String(value||''),parsed=Date.parse(date+'T12:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==date||Math.abs(parsed-Date.now())>367*86400000)throw cashError('Escolha uma data dentro de um ano.');
  return date;
}
export function freeRanges({date,start,end,blocks,now=Date.now()}){
  let begin=minutes(start);const finish=minutes(end);
  if(finish<=begin)throw cashError('Faixa de horários da agenda inválida.',502);
  const today=new Date(now).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
  if(date<today)return [];
  if(date===today){const local=new Date(now).toLocaleTimeString('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});begin=Math.max(begin,Math.ceil((minutes(local)+1)/5)*5);}
  const busy=blocks.map(b=>[minutes(b.start),minutes(b.end)]).sort((a,b)=>a[0]-b[0]);
  if(busy.some(([a,b])=>a>=b))throw cashError('Bloqueio da agenda inválido.',502);
  const ranges=[];let cursor=begin;
  for(const [a,b] of busy){if(b<=cursor||a>=finish)continue;if(a>cursor)ranges.push({start:clock(cursor),end:clock(Math.min(a,finish))});cursor=Math.max(cursor,b);}
  if(cursor<finish)ranges.push({start:clock(cursor),end:clock(finish)});
  return ranges;
}

// Read only times and block categories. Customer names and phones never leave
// the provider's event DOM in the weekly availability response.
export function parseCalendar(data,date,professionals,now=Date.now()){
  if(!data.headers.length||data.headers.length!==data.columns.length||data.headers.some(n=>!n)||new Set(data.headers).size!==data.headers.length)throw cashError('Colunas da agenda não reconhecidas. Consulta interrompida.',502);
  const times=[...new Set(data.times)].sort(),step=times.length>1?minutes(times[1])-minutes(times[0]):0;
  if(!step||step>60||minutes(times.at(-1))+step>=1440)throw cashError('Escala de horários não reconhecida.',502);
  const start=times[0],end=clock(minutes(times.at(-1))+step),rows=[];
  for(let i=0;i<data.headers.length;i++){
    const name=data.headers[i],matches=professionals.filter(p=>p.name===name),blocks=data.columns[i];
    const invalid=blocks.some(b=>!/^\d{2}:\d{2}$/.test(b.start||'')||!/^\d{2}:\d{2}$/.test(b.end||''));
    let windows=[],error=invalid?'Há um bloqueio que não pôde ser interpretado.':'';
    if(!invalid){try{windows=freeRanges({date,start,end,blocks,now});}catch{error='Horários da agenda não puderam ser interpretados.';}}
    rows.push({id:matches.length===1?matches[0].id:'',name,windows,blocks:invalid?[]:blocks,error});
  }
  for(const p of professionals)if(!rows.some(r=>r.id===p.id||r.name===p.name))rows.push({...p,windows:[],blocks:[],error:'Profissional não exibida na agenda desta data.'});
  return {date,start,end,professionals:rows,checkedAt:now};
}
