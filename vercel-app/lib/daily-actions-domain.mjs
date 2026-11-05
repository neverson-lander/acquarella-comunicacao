export const dayAt=stamp=>new Date(stamp).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
export const scheduledAt=(day,feature)=>Date.parse(day+`T${feature==='subscriptions'?'08':'07'}:00:00-03:00`);
export function subscriptionDue(day,billingDay){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isInteger(Number(billingDay))||billingDay<1||billingDay>31)return null;
 const [year,month]=day.split('-').map(Number),last=new Date(Date.UTC(year,month,0)).getUTCDate();
 return `${day.slice(0,8)}${String(Math.min(Number(billingDay),last)).padStart(2,'0')}`;
}
export function subscriptionTargets(day){return [{day,notice:'due'},{day:dayAt(Date.parse(day+'T12:00:00-03:00')+3*86400000),notice:'advance'}];}
export function subscriptionText(day,checkout){
 const date=day.split('-').reverse().join('/');
 if(checkout){
  const amount=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(checkout.cents/100);
  return `Oi, tudo bem? 💛 Passando só para lembrar que a próxima renovação da sua assinatura do Espaço Acquarella é no dia *${date}*.

O valor da renovação é *${amount}*. Se quiser renovar pelo Mercado Pago, deixamos o link aqui para facilitar:

${checkout.url}

Se preferir renovar por Pix direto pelo aplicativo do seu banco, é só copiar a chave abaixo:

*Chave Pix (CNPJ do Espaço Acquarella)*
55771128000140

Se precisar de ajuda, é só falar com a gente por aqui. 😊

É sempre um prazer cuidar de você. Até a próxima visita! 💛

Com carinho,
*Equipe Espaço Acquarella*`;
 }
 return `Oi, tudo bem? 💛 Passando só para lembrar que a próxima renovação da sua assinatura do Espaço Acquarella é no dia *${date}*.

Se quiser renovar por Pix, deixamos a chave aqui para facilitar:

*Chave Pix (CNPJ do Espaço Acquarella)*
55771128000140

Se preferir renovar com cartão, é só falar com a gente por aqui que enviamos um link. 😊

É sempre um prazer cuidar de você. Até a próxima visita! 💛

Com carinho,
*Equipe Espaço Acquarella*`;
}
export function oldComanda(row,now=Date.now()){
 const created=Date.parse(row.created_at);
 return Number(row.com_pago)===0&&Number(row.com_active)===1&&Number.isFinite(created)&&now-created>3*86400000;
}
