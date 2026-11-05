export function investmentComparison(analysis,spend,view='direct'){
 const bookings=new Map();
 if(view==='acquisition')for(const c of analysis.acquisition){
  if(!bookings.has(c.campaign))bookings.set(c.campaign,{id:c.campaign,name:c.campaign_name,contacts:0,scheduled:0,services:0,value_cents:0,unknown_value:0});
  const row=bookings.get(c.campaign);row.contacts++;row.scheduled+=c.converted;row.services+=c.services.length;row.value_cents+=c.value_cents;row.unknown_value+=c.unknown_value;
 }else for(const g of analysis.groups)bookings.set(g.id,{...g,contacts:g.attendances});
 const rows=new Map((spend.campaigns||[]).map(c=>[c.id,{...c,contacts:0,scheduled:0,services:0,value_cents:0,unknown_value:0}]));
 const known=new Set(spend.known_campaign_ids||[]);
 for(const g of bookings.values()){
  const cost=rows.get(g.id)?.spend_cents??(known.has(g.id)?0:null);
  rows.set(g.id,{...rows.get(g.id),...g,spend_cents:cost});
 }
 const enrich=row=>({...row,ratio:row.spend_cents>0?row.value_cents/row.spend_cents:null,cost_per_scheduled:row.spend_cents!==null&&row.scheduled?Math.round(row.spend_cents/row.scheduled):null,balance:row.spend_cents===null?null:row.value_cents-row.spend_cents});
 const totals={spend_cents:0,value_cents:0,scheduled:0,services:0,unknown_value:0,unmapped:0};
 for(const row of rows.values())if(row.spend_cents===null)totals.unmapped++;else{totals.spend_cents+=row.spend_cents;totals.value_cents+=row.value_cents;totals.scheduled+=row.scheduled;totals.services+=row.services;totals.unknown_value+=row.unknown_value;}
 return {view,rows:[...rows.values()].map(enrich).sort((a,b)=>(b.spend_cents??-1)-(a.spend_cents??-1)||a.name.localeCompare(b.name)),totals:enrich(totals)};
}
export function investmentCsv(report,spend){
 const rows=[['Visão',report.view==='direct'?'Conversão direta':'Aquisição e retornos'],['Gasto de',spend.from,'até',spend.to],['Campanha','Gasto Meta centavos','Atendimentos / contatos','Com agendamento','Serviços','Valor agendado centavos','Retorno em agendamentos (vezes)','Diferença potencial centavos','Serviços sem valor'],...report.rows.map(r=>[r.name,r.spend_cents,r.contacts,r.scheduled,r.services,r.value_cents,r.ratio,r.balance,r.unknown_value])];
 return '\ufeff'+rows.map(row=>row.map(v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(';')).join('\r\n');
}
