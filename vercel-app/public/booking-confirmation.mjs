const clean=v=>String(v||'').replace(/\s+/g,' ').trim();
export function bookingConfirmationText(bookings,clientId,clientName=''){
 if(!clientId)return '';
 const rows=[],seen=new Set();
 for(const b of bookings||[]){
  const q=b.quote||{};if(b.state!=='confirmed'||b.closure_id||String(q.clientId)!==String(clientId))continue;
  const date=String(q.date||''),start=String(q.start||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(start))continue;
  const parsed=Date.parse(date+'T12:00:00Z');if(!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==date)continue;
  const services=q.services?.length?q.services.map(s=>({id:s.id,name:s.name})):[{id:q.serviceId,name:q.service}];
  for(const s of services){const name=clean(s.name);if(!name)continue;
   const key=[b.receipt?.externalId||b.id||'',s.id||name,date,start].join('|');if(seen.has(key))continue;seen.add(key);rows.push({name,date,start,clientName:clean(q.clientName)});
  }
 }
 rows.sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start)||a.name.localeCompare(b.name,'pt-BR'));
 if(!rows.length)return '';
 const customer=clean(clientName)||rows.find(r=>r.clientName)?.clientName;
 return `${customer?`Olá, ${customer}!`:'Olá!'} ✨\n\nÉ um prazer confirmar seu horário no Espaço Acquarella.\n\n`+
  rows.map((r,index)=>`${rows.length>1?`*Agendamento ${index+1}*\n\n`:''}📋 Serviço: ${r.name}\n\n📅 Data: ${r.date.split('-').reverse().join('/')}\n\n🕒 Horário: ${r.start}`).join('\n\n\n')+
  '\n\nCaso precise ajustar seu horário ou tenha qualquer dúvida, estamos à disposição por aqui.\n\nSerá um prazer te receber!!\n\nAté breve!\nEquipe Espaço Acquarella';
}
export function mergeBookingConfirmation(draft,text,previous=''){
 if(!text||draft.includes(text))return draft;
 if(previous&&draft.includes(previous))return draft.replace(previous,text);
 return draft.trim()?draft+'\n\n'+text:text;
}
