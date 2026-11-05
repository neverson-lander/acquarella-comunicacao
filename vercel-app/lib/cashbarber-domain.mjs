export const cashError=(message,status=400)=>Object.assign(Error(message),{status});
export function externalId(value){if(!/^\d{1,12}$/.test(String(value||'')))throw cashError('Identificador CashBarber inválido.');return String(value);}
export function bookingInput(input,{allowElapsedStart=false,now=Date.now()}={}){
  const date=String(input.date||''),start=String(input.start||'');
  const parsed=new Date(date+'T12:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)throw cashError('Data inválida.');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(start))throw cashError('Horário inválido.');
  const timestamp=Date.parse(date+'T'+start+':00-03:00');
  const today=new Date(now).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
  if(timestamp<now&&!(allowElapsedStart&&date===today))throw cashError('O início selecionado já passou. Escolha um horário futuro (horário de Brasília).');
  if(timestamp>now+366*86400000)throw cashError('Escolha uma data dentro de um ano.');
  const service=String(input.service||'').trim();if(!service||service.length>300)throw cashError('Selecione um serviço.');
  return {clientId:externalId(input.clientId),professionalId:externalId(input.professionalId),service,date,start};
}
export const minutes=time=>{if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw cashError('Horário inválido.');const [h,m]=time.split(':').map(Number);return h*60+m;};
export const clock=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
export function availableSlots({date,duration,work=[],blocks=[],now=Date.now()}){
  if(!Number.isInteger(duration)||duration<1||duration>720)throw cashError('Duração do serviço inválida.');
  const ranges=work.map(r=>[minutes(r.start),minutes(r.end)]),busy=blocks.map(r=>[minutes(r.start),minutes(r.end)]),out=new Set();
  for(const [begin,end] of ranges)for(let t=begin;t+duration<=end;t+=5){
    if(Date.parse(date+'T'+clock(t)+':00-03:00')<=now||busy.some(([a,b])=>t<b&&t+duration>a))continue;out.add(clock(t));
  }
  return [...out].sort();
}
export function sameQuote(a,b){return a.clientId===b.clientId&&a.professionalId===b.professionalId&&a.service===b.service&&a.date===b.date&&a.start===b.start&&a.end===b.end&&a.price===b.price&&a.duration===b.duration;}

export function appointmentPeriod(input){
  const check=value=>{const date=String(value||''),parsed=new Date(date+'T12:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)throw cashError('Data do agendamento inválida.');return date;};
  if(input.from!==undefined||input.to!==undefined){const from=check(input.from),to=check(input.to);if(to<from||Date.parse(to)-Date.parse(from)>366*86400000)throw cashError('Consulte um período de até 12 meses.');return {from,to};}
  return {date:check(input.date)};
}
