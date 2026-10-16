const invalid=message=>Object.assign(Error(message),{status:400});
export const dayNames=['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
export const periodNames={always:'A qualquer horário',inside:'Dentro do horário de atendimento',outside:'Fora do horário de atendimento'};
export const defaultServiceHours=()=>({enabled:false,timezone:'America/Sao_Paulo',days:Array.from({length:7},(_,day)=>day>0&&day<6?[{start:'09:00',end:'18:00'}]:[])});
function minute(value,end=false){
  if(end&&value==='24:00')return 1440;
  if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw invalid('Informe horários no formato HH:MM.');
  return Number(value.slice(0,2))*60+Number(value.slice(3));
}
export function normalizeServiceHours(value){
  if(value===undefined||value===null)return defaultServiceHours();
  if(typeof value!=='object'||Array.isArray(value)||typeof value.enabled!=='boolean')throw invalid('Grade de atendimento inválida.');
  if(typeof value.timezone!=='string'||value.timezone.length>80)throw invalid('Fuso horário inválido.');
  try{new Intl.DateTimeFormat('en-US',{timeZone:value.timezone}).format();}catch{throw invalid('Fuso horário inválido.');}
  if(!Array.isArray(value.days)||value.days.length!==7)throw invalid('Configure os sete dias da semana.');
  const ranges=[],days=value.days.map((slots,day)=>{
    if(!Array.isArray(slots)||slots.length>4)throw invalid('Use até quatro intervalos por dia.');
    return slots.map(slot=>{
      if(!slot||typeof slot!=='object')throw invalid('Intervalo de atendimento inválido.');
      const start=minute(slot.start),end=minute(slot.end,true);
      if(start===end)throw invalid('Início e fim não podem ser iguais. Para o dia inteiro, use 00:00–24:00.');
      const from=day*1440+start,to=day*1440+end+(end<start?1440:0);
      ranges.push([from,Math.min(to,10080)]);if(to>10080)ranges.push([0,to-10080]);
      return {start:slot.start,end:slot.end};
    }).sort((a,b)=>minute(a.start)-minute(b.start));
  });
  ranges.sort((a,b)=>a[0]-b[0]);
  for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])throw invalid('Há horários sobrepostos na grade, inclusive na virada do dia.');
  if(value.enabled&&!ranges.length)throw invalid('Adicione pelo menos um intervalo para ativar a grade.');
  return {enabled:value.enabled,timezone:value.timezone,days};
}
export function withinServiceHours(hours,timestamp=Date.now()){
  if(!hours?.enabled)return false;
  const stamp=Number(timestamp);if(!Number.isFinite(stamp))return false;
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:hours.timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(stamp)).map(v=>[v.type,v.value]));
  const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday),time=Number(parts.hour)*60+Number(parts.minute);
  const today=hours.days[day]||[],yesterday=hours.days[(day+6)%7]||[];
  return today.some(s=>{const a=minute(s.start),b=minute(s.end,true);return b>a?time>=a&&time<b:time>=a;})||yesterday.some(s=>{const a=minute(s.start),b=minute(s.end,true);return b<a&&time<b;});
}
export function forwardingPeriodAllows(account,timestamp=Date.now()){
  const period=account.forwarding_period||'always';if(period==='always')return true;
  if(!['inside','outside'].includes(period)||!account.service_hours?.enabled||!Number.isFinite(Number(timestamp)))return false;
  try{const inside=withinServiceHours(account.service_hours,timestamp);return period==='inside'?inside:!inside;}catch{return false;}
}
export function normalizeForwardingSettings(input,old={}){
  const hours=normalizeServiceHours(input.serviceHours===undefined?old.service_hours:input.serviceHours);
  const period=input.forwardingPeriod??old.forwarding_period??'always';
  if(!Object.hasOwn(periodNames,period))throw invalid('Escolha quando encaminhar as mensagens.');
  if(period!=='always'&&!hours.enabled)throw invalid('Ative a grade para encaminhar dentro ou fora do horário.');
  const value=input.forwardingPhone??old.forwarding_phone??'';
  if(typeof value!=='string'||value.length>32||(value&&!/^\+?[\d\s().-]+$/.test(value.trim())))throw invalid('Telefone de destino inválido. Use código do país e DDD.');
  const phone=value.replace(/\D/g,'');if(phone&&!/^[1-9]\d{9,14}$/.test(phone))throw invalid('Telefone de destino inválido. Use código do país e DDD.');
  return {hours,period,phone};
}
