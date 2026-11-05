import {cashError} from './cashbarber-domain.mjs';
import {createCashbarberClient} from './cashbarber-client.mjs';
import {dayAt,subscriptionTargets,subscriptionText} from './daily-actions-domain.mjs';
import {normalizeContactPhone} from '../public/contact-domain.mjs';

export function createMercadoPagoSettings({pool,seal,sampleCheckout,client=createCashbarberClient().forService(),now=Date.now}){
  function credential(value,label){
    if(value===undefined||value==='')return null;
    if(typeof value!=='string'||!/^\S{1,2048}$/.test(value.trim()))throw cashError(label+' inválido.');
    return seal(value.trim());
  }

  async function sample(tenant){
    const checkout=await sampleCheckout(tenant);
    const messages=[],errors=[];
    for(const {day:date,notice} of subscriptionTargets(dayAt(now()))){
      let items;
      try{
        ({items}=await client.call(tenant,'daily-subscriptions',{date}));
      }catch(error){
        errors.push({date,message:error.status?error.message:'Não foi possível consultar as assinaturas no CashBarber.'});
        continue;
      }
      for(const item of items.slice(0,3)){
        try{
          const customer=await client.call(tenant,'daily-subscriber',{...item,date,notice});
          if(!customer.active)continue;
          normalizeContactPhone(customer.phone);
          const payment=await checkout(customer);
          messages.push({name:customer.name,date,notice,body:subscriptionText(date,payment),url:payment.url});
          break;
        }catch(error){
          errors.push({date,message:error.status?error.message:'Não foi possível preparar a amostra para uma assinatura.'});
        }
      }
    }
    return {messages,errors};
  }

  return async function settings(user,input={}){
    if(user.role!=='admin')throw cashError('Apenas administradores configuram o Mercado Pago.',403);
    if(input.action==='sample')return sample(user.tenant);
    if(input.action==='save'){
      if(!['test','production'].includes(input.environment))throw cashError('Selecione um ambiente válido.');
      const token=credential(input.accessToken,'Access Token');
      const secret=credential(input.webhookSecret,'Segredo do webhook');
      if(input.linksEnabled!==undefined&&(input.environment!=='production'||typeof input.linksEnabled!=='boolean'))throw cashError('Ative links somente no ambiente de produção.');
      if(input.linksEnabled===true&&!token&&!(await pool.query("select 1 from mercado_pago_settings where tenant=$1 and environment='production' and access_token is not null",[user.tenant])).rows.length)throw cashError('Salve um Access Token de produção para ativar os links.');
      if(!token&&!secret&&input.linksEnabled===undefined)throw cashError('Informe pelo menos uma credencial para salvar.');
      await pool.query(`insert into mercado_pago_settings as settings(tenant,environment,access_token,webhook_secret,links_enabled)
        values($1,$2,$3::text,$4,coalesce($5,false) and $3::text is not null) on conflict(tenant,environment) do update set
        access_token=coalesce(excluded.access_token,settings.access_token),
        webhook_secret=coalesce(excluded.webhook_secret,settings.webhook_secret),
        links_enabled=coalesce($5,settings.links_enabled)`,
      [user.tenant,input.environment,token,secret,input.linksEnabled??null]);
    }else if(input.action!==undefined){
      throw cashError('Ação inválida.');
    }
    const {rows}=await pool.query(`select environment,access_token is not null as has_token,
      webhook_secret is not null as has_webhook_secret,links_enabled from mercado_pago_settings where tenant=$1`,[user.tenant]);
    return {environments:rows};
  };
}
