import {cashError,externalId} from '../vercel-app/lib/cashbarber-domain.mjs';
import {subscriptionDue,oldComanda} from '../vercel-app/lib/daily-actions-domain.mjs';
const list=x=>{if(!Array.isArray(x))throw cashError('Formato de resposta CashBarber inválido.',502);return x;};
const norm=x=>String(x||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').trim().toLowerCase().replace(/\s+/g,' ');
export async function subscriptionList(api,tenant,input){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(input.date||''))throw cashError('Data inválida.');
 const rows=list(await api.request(tenant,'clientes/assinaturas',{plano:null,data:input.date,tipo:'manual'}));
 return {items:rows.filter(r=>subscriptionDue(input.date,r.clp_dia_cobranca)===input.date).map(r=>({id:externalId(r.id),name:String(r.cli_name||''),plan:externalId(r.clp_id_plano),billingDay:Number(r.clp_dia_cobranca)}))};
}
export async function subscriptionCustomer(api,tenant,input){
 const id=externalId(input.id),planId=externalId(input.plan);
 if(typeof input.name!=='string'||!input.name.trim()||input.name.length>200)throw cashError('Assinatura sem nome verificável.',422);
 const candidates=list(await api.request(tenant,'clientes/simpleList',{termo:input.name})).filter(c=>norm(c.cli_name)===norm(input.name));
 if(candidates.length>20)throw cashError('Assinatura com muitos cadastros homônimos. Confira no CashBarber.',422);
 const matches=[];
 for(const candidate of candidates){
  const customer=await api.request(tenant,'clientes/'+externalId(candidate.id));
  const plans=[customer.cliente_plano,...(Array.isArray(customer.assinaturas)?customer.assinaturas:[])].flat().filter(Boolean);
  for(const p of plans)if(String(p.id)===id&&String(p.clp_id_cliente)===String(customer.id)&&String(p.clp_id_plano)===planId){
   const active=Number(customer.cli_active)===1&&Number(p.clp_active)===1&&Number(p.clp_assinatura_pausada||0)===0&&p.clp_forma_pagamento==='manual'&&['active','pastdue'].includes(p.clp_status_assinatura_manual)&&(!p.clp_data_inicio||p.clp_data_inicio.slice(0,10)<=input.date)&&(!p.clp_data_fim||p.clp_data_fim.slice(0,10)>=input.date)&&subscriptionDue(input.date,p.clp_dia_cobranca)===input.date;
   if(active)matches.push({clientId:String(customer.id),name:customer.cli_name,phone:String(customer.cli_telefone||''),email:customer.email||'',renewalValue:p.clp_valor??null});
  }
 }
 if(matches.length!==1)return {active:false};
 return {active:true,...matches[0]};
}
export async function comandaOptions(api,tenant){
 const branch=await api.branch(tenant);
 const boxes=list(await api.request(tenant,'caixas/simpleList')).filter(r=>Number(r.cai_active)===1&&String(r.cai_id_filial)===branch).map(r=>({id:String(r.id),name:r.cai_nome}));
 // These methods only register a receipt; gateway and card operations are excluded.
 const methods=list(await api.request(tenant,'financeiro/formas-pagamento/simpleList')).filter(r=>Number(r.fop_active)===1&&r.fop_tipo==='A VISTA'&&!/PAGAMENT|CARTAO|CASH.?PAG/i.test(r.fop_nome_predefinido||'')).map(r=>({id:String(r.id),name:r.fop_nome,code:r.fop_nome_predefinido}));
 return {boxes,methods};
}
export async function comandaPage(api,tenant,input){
 const page=Number(input.page||0);if(!Number.isInteger(page)||page<0||page>10000)throw cashError('Página inválida.');
 const branch=await api.branch(tenant);
 const raw=await api.request(tenant,'comandas/list',{data:null,rows:1000,totalRecords:0,first:page*1000,last:0,page,loading:true,globalFilter:null,com_id_filial:Number(branch)}),data=raw?.data;
 if(!Number.isInteger(data?.last_page)||data.last_page<1)throw cashError('Paginação de comandas inválida.',502);
 return {ids:list(data.data).filter(r=>String(r.com_id_filial)===branch&&oldComanda(r)).map(r=>externalId(r.id)),lastPage:data.last_page};
}
export function comandaBalanceCents(raw){
 const value=raw.saldo;
 if((typeof value!=='number'&&typeof value!=='string')||String(value).trim()==='')return null;
 const cents=Number(value);
 return Number.isSafeInteger(cents)&&cents>=0?cents:null;
}

export function canRetryComanda(prior,raw,{cashbox,payment_method}){
 const cents=comandaBalanceCents(raw);
 return prior?.state==='uncertain'&&(!prior.retried||prior.balanceCents===undefined)&&
  cents!==null&&cents===(prior.balanceCents??prior.amount)&&
  Array.isArray(raw.movimentacoes_registros)&&raw.movimentacoes_registros.length===0&&
  (!prior.cashbox||cashbox===prior.cashbox)&&(!prior.paymentMethod||payment_method===prior.paymentMethod);
}

export async function closeComanda(api,tenant,input){
 const id=externalId(input.id),key='daily_close_'+tenant+'_'+id;
 const prior=await api.vault.read(key);
 if(prior?.state==='closed')return {state:'closed'};
 if(prior?.state==='failed')return {state:'failed',error:prior.error};
 const retry=input.retryUnconfirmed===true&&prior?.state==='uncertain'&&(!prior.retried||prior.balanceCents===undefined);
 if(prior&&!retry)return {state:'uncertain',error:'Operação já iniciada. Confira no CashBarber; não será repetida.'};
 const raw=await api.request(tenant,'comandas/'+id),branch=await api.branch(tenant);
 if(String(raw.id)!==id||String(raw.com_id_filial)!==branch)throw cashError('Comanda de outra filial ou inválida.',422);
 if(!oldComanda(raw))return {state:'skipped',error:'Comanda já fechada, inativa ou com até 72 horas.'};
 const options=await comandaOptions(api,tenant);
 const payment=options.methods.find(x=>x.id===input.payment_method);
 if(!options.boxes.some(x=>x.id===input.cashbox)||!payment?.code)throw cashError('Caixa ou forma de pagamento indisponível.',422);
 const balanceCents=comandaBalanceCents(raw);
 if(balanceCents===null)throw cashError('Saldo da comanda não verificável.',422);
 if(input.retryUnconfirmed===true&&!canRetryComanda(prior,raw,input))
  return {state:'uncertain',error:'Nova tentativa suspensa: saldo, movimentações ou configuração não correspondem à tentativa anterior.'};
 const amount=balanceCents/100;
 const payload={
  caixa_id:input.cashbox,
  movimentacoes_registros:[{forma_pagamento_id:payment.id,forma_pagamento:payment.code,valor_pagamento:amount,cartao:''}],
  servicos_com_desconto:(raw.comanda_agendamentos||[]).flatMap(({agendamento})=>agendamento.agendamento_servicos.map(s=>({
   servico:{...s.servico,id:s.id,ser_valor:s.ags_valor},desconto:s.ags_desconto
  }))),
  produtos_com_desconto:(raw.produtos||[]).map(p=>({
   produto:{...p,produto:{...p.produto,pro_valor:p.cop_valor}},desconto:p.cop_desconto,quantidade:p.cop_quantidade
  }))
 };
 // Durable before the financial write. An ambiguous response is never retried.
 await api.vault.write(key,{state:'sending',at:Date.now(),cashbox:input.cashbox,paymentMethod:input.payment_method,amount,balanceCents,retried:retry});
 let accepted=false;
 try{
  await api.request(tenant,'comandas/fechar/'+id,payload,'PUT');
  accepted=true;
  const result=await api.request(tenant,'comandas/'+id);
  if(String(result.id)!==id||String(result.com_id_filial)!==branch||Number(result.com_pago)!==1)throw Error('unconfirmed');
  await api.vault.write(key,{state:'closed',at:Date.now(),amount,balanceCents});
  return {state:'closed'};
 }catch(error){
  const rejected=!accepted&&[400,422].includes(error.providerStatus);
  const state=rejected?'failed':'uncertain';
  const detail=rejected
   ?`O CashBarber recusou os dados do fechamento (HTTP ${error.providerStatus}).`
   :accepted?'O CashBarber aceitou a solicitação, mas a baixa não foi confirmada.'
   :error.providerStatus?`O CashBarber retornou HTTP ${error.providerStatus} no fechamento.`
   :'A resposta ao pedido de fechamento não pôde ser confirmada.';
  const message=detail+' Confira a comanda no CashBarber. A operação não será repetida automaticamente.';
  await api.vault.write(key,{state,at:Date.now(),amount,balanceCents,error:message,retried:retry,cashbox:input.cashbox,paymentMethod:input.payment_method});
  return {state,error:message};
 }
}
