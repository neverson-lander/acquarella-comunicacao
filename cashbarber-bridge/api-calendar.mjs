import {cashError,externalId,minutes} from '../vercel-app/lib/cashbarber-domain.mjs';
import {freeRanges} from './calendar.mjs';

const invalid=()=>cashError('Resposta da agenda CashBarber não reconhecida. Atualize a consulta.',502);
export function localTime(value,date){
  const match=String(value||'').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/);
  if(!match||match[1]!==date)throw invalid();
  minutes(match[2]);return match[2];
}
function eventRange(event,date,start,end){
  const normalized=value=>{
    const text=String(value||'').replace('T',' ');
    if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text))throw invalid();
    minutes(text.slice(11,16));return text.slice(0,16);
  };
  const a=normalized(event.start),b=normalized(event.end),lower=date+' '+start,upper=date+' '+end;
  if(a>=b)throw invalid();
  if(a>=upper||b<=lower)return null;
  return {start:a<lower?start:a.slice(11,16),end:b>upper?end:b.slice(11,16)};
}
export function apiCalendar(data,date,professionals,now=Date.now()){
  for(const key of ['barbeiros','horarios','agendamentos','intervalos','folgas'])if(!Array.isArray(data?.[key]))throw invalid();
  const start=localTime(data.min,date),end=localTime(data.max,date);
  if(minutes(start)>=minutes(end))throw invalid();
  const visible=new Set(data.barbeiros.map(p=>externalId(p.id)));
  const events=[...data.agendamentos,...data.intervalos,...data.folgas];
  // An event without an owner cannot safely be assigned to a single column.
  if(events.some(e=>!/^\d{1,12}$/.test(String(e.id_barbeiro||''))))throw invalid();
  const rows=professionals.map(person=>{
    try{
      if(!visible.has(person.id))return {...person,windows:[],blocks:[],error:'Profissional não exibido na agenda desta data.'};
      const work=data.horarios.filter(h=>String(h.id_barbeiro)===person.id).map(h=>({start:localTime(h.entrada,date),end:localTime(h.saida,date)}));
      const blocks=events.filter(e=>String(e.id_barbeiro)===person.id).flatMap(e=>{const range=eventRange(e,date,start,end);return range?[{...range,kind:e.classNames==='blocked'||e.title==='Bloqueado'?'blocked':e.classNames==='break'||data.folgas.includes(e)?'off':'busy'}]:[];});
      if(work.some(w=>minutes(w.start)>=minutes(w.end))||blocks.some(b=>minutes(b.start)>=minutes(b.end)))throw invalid();
      const windows=work.flatMap(w=>freeRanges({date,start:w.start,end:w.end,blocks,now})).sort((a,b)=>a.start.localeCompare(b.start));
      // Merge overlapping work shifts so the UI never offers duplicate windows.
      const merged=[];for(const w of windows){const last=merged.at(-1);if(last&&w.start<=last.end)last.end=last.end>w.end?last.end:w.end;else merged.push({...w});}
      return {id:person.id,name:person.name,windows:merged,blocks,error:''};
    }catch{return {id:person.id,name:person.name,windows:[],blocks:[],error:'Escala ou bloqueio não reconhecido. Confira a agenda no CashBarber.'};}
  });
  return {date,start,end,professionals:rows,checkedAt:now};
}
