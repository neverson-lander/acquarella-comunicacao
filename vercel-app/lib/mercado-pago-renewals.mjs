import {randomUUID} from 'node:crypto';
import {cashError} from './cashbarber-domain.mjs';

function renewalCents(value){
  const match=/^(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(String(value??'').trim());
  return match?Number(match[1])*100+Number((match[2]||'').padEnd(2,'0')):0;
}

export function createMercadoPagoRenewals({pool,open,fetcher=fetch}){
  async function request(token,path,body,key){
    let response;
    try{
      response=await fetcher('https://api.mercadopago.com/v1/orders'+path,{
        method:body?'POST':'GET',
        headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json','X-Idempotency-Key':key}:{})},
        body:body?JSON.stringify(body):undefined,
        signal:AbortSignal.timeout(7000),
        redirect:'error'
      });
      if(response.ok)return await response.json();
    }catch{
      throw cashError('O Mercado Pago não confirmou a consulta ou criação do link.',502);
    }
    throw cashError(`O Mercado Pago recusou a consulta ou criação do link (HTTP ${response.status}).`,502);
  }

  function amountFor(customer){
    const cents=renewalCents(customer.renewalValue);
    if(!cents||cents>2147483647)throw cashError('Valor da renovação inválido no CashBarber (clp_valor).',422);
    return cents;
  }

  function createOrder(token,cents,reference){
    const amount=(cents/100).toFixed(2);
    return request(token,'',{
      type:'online',processing_mode:'manual',total_amount:amount,external_reference:reference,
      expiration_time:'P5D',items:[{title:'Renovação de assinatura · Espaço Acquarella',quantity:1,unit_price:amount}]
    },reference);
  }

  function validateOrder(data,reference,cents){
    if(!data?.id||data.external_reference!==reference||data.currency!=='BRL'||renewalCents(data.total_amount)!==cents)
      throw cashError('A cobrança retornada pelo Mercado Pago não corresponde à renovação.',502);
  }

  function checkoutUrl(data,fallback=''){
    const url=URL.parse(data.checkout_url||fallback);
    if(!url||url.protocol!=='https:'||url.hostname!=='www.mercadopago.com.br'||url.username||url.password||url.port)
      throw cashError('O Mercado Pago não retornou um link de pagamento válido.',502);
    return url.href;
  }

  async function sampleCheckout(tenant){
    const {rows:[config]}=await pool.query("select access_token from mercado_pago_settings where tenant=$1 and environment='test'",[tenant]);
    if(!config?.access_token)throw cashError('Salve o Access Token no ambiente Teste para gerar a amostra.',409);
    const token=open(config.access_token);
    let seller;
    try{
      const response=await fetcher('https://api.mercadolibre.com/users/me',{
        headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(7000),redirect:'error'
      });
      if(response.ok)seller=await response.json();
    }catch{
      throw cashError('Não foi possível verificar a conta de teste do Mercado Pago.',502);
    }
    if(!Array.isArray(seller?.tags)||!seller.tags.includes('test_user'))throw cashError('Use o Access Token de uma conta vendedora de teste do Mercado Pago.',409);
    return async customer=>{
      const cents=amountFor(customer),reference=randomUUID();
      const data=await createOrder(token,cents,reference);
      validateOrder(data,reference,cents);
      if(!/^ORDTST/.test(data.id)||data.status!=='created')throw cashError('O Mercado Pago não confirmou uma cobrança de teste aberta.',502);
      return {cents,url:checkoutUrl(data)};
    };
  }

  async function renewal(tenant,item,customer){
    const {rows:[config]}=await pool.query("select access_token from mercado_pago_settings where tenant=$1 and environment='production' and links_enabled",[tenant]);
    if(!config)return null;
    const cents=amountFor(customer);
    const token=open(config.access_token);
    const identity=[tenant,item.id,item.date];
    await pool.query(`insert into mercado_pago_renewals(tenant,subscription,due_date,request_id,cents)
      values($1,$2,$3,$4,$5) on conflict(tenant,subscription,due_date) do nothing`,[...identity,randomUUID(),cents]);
    const {rows:[order]}=await pool.query('select * from mercado_pago_renewals where tenant=$1 and subscription=$2 and due_date=$3',identity);
    if(order.cents!==cents)throw cashError('O valor da renovação mudou após a criação da cobrança. Confira no Mercado Pago.',409);
    const data=order.order_id
      ?await request(token,'/'+encodeURIComponent(order.order_id))
      :await createOrder(token,cents,order.request_id);
    validateOrder(data,order.request_id,cents);
    if(renewalCents(data.total_paid_amount)===cents&&data.status==='processed'&&data.status_detail==='accredited')return {paid:true};
    if(data.status!=='created'||renewalCents(data.total_paid_amount)>0)
      throw cashError('A cobrança está em um estado que requer conferência no Mercado Pago.',409);
    const url=checkoutUrl(data,order.checkout_url||'');
    await pool.query('update mercado_pago_renewals set order_id=$4,checkout_url=$5 where tenant=$1 and subscription=$2 and due_date=$3',[...identity,data.id,url]);
    return {url,cents};
  }
  return {renewal,sampleCheckout};
}
