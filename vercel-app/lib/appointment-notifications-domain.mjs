const hour=3600000;
export const notificationDay=24*hour;
export const notificationGrace=10*60000;
export const localDate=stamp=>new Date(stamp).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
export const allowedMessageTime=stamp=>Number(new Date(stamp).toLocaleTimeString('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',hourCycle:'h23'}))>=8;
export const messageDue=stamp=>Math.max(stamp,Date.parse(localDate(stamp)+'T08:00:00-03:00'));
// Missing provider creation dates must never be replaced with discovery time.
export function notificationPlan(booking,now){
  const {startsAt,createdAt,bookedAt=createdAt}=booking;
  if(!booking.active||![startsAt,createdAt,bookedAt].every(Number.isSafeInteger)||bookedAt>startsAt||createdAt>startsAt||startsAt<=now)return [];
  const date=localDate(startsAt);
  if(localDate(bookedAt)===date)return [];
  if(date===localDate(now))return [{kind:'reminder',due:Math.max(startsAt-2*hour,Date.parse(date+'T08:00:00-03:00'))}];
  if(date===localDate(now+notificationDay)&&startsAt-bookedAt>=notificationDay)return [{kind:'confirmation',due:messageDue(startsAt-notificationDay)}];
  return [];
}
export function notificationText(booking,kind,sendAt=Date.now()){
  const clean=v=>String(v||'').replace(/[\r\n\t]+/g,' ').slice(0,200);
  const name=clean(booking.clientName).trim().split(/\s+/)[0]||'tudo bem';
  const date=new Date(booking.startsAt).toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
  const times=[...new Set((booking.appointments||[booking]).map(b=>b.startsAt))].sort((a,b)=>a-b).map(stamp=>new Date(stamp).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}).replace(':','h'));
  const time=times.length>1?times.slice(0,-1).join(', ')+' e '+times.at(-1):times[0];
  const day=localDate(booking.startsAt)===localDate(sendAt)?'hoje':`no dia ${date}`;
  if(kind==='confirmation')return `Olá, ${name}! 💕\n\nSeu atendimento no Espaço Acquarella está agendado para ${day==='hoje'?'hoje':`o dia ${date}`}, às ${time}!\n\n⏰ Temos uma tolerância de 10 minutinhos para atrasos, ok? Assim, conseguimos manter a agenda organizada e garantir o melhor atendimento a todos. Após esse prazo, seu horário poderá ser reorganizado conforme a disponibilidade da agenda do dia.\n\nVai ser ótimo ter você com a gente! 💖`;
  return `Olá, ${name}! 💕\n\n✨ Passando para lembrar que seu atendimento no Espaço Acquarella será ${day}, às ${time}!\n\n⏰ Lembramos que nossa tolerância para atrasos é de 10 minutinhos.\n\nEstamos esperando você com carinho! 💖`;
}
