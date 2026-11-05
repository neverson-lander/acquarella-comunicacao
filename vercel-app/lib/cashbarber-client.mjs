import {qrHeaders} from './qr-protocol.mjs';
import {cashError} from './cashbarber-domain.mjs';
export function createCashbarberClient({env=process.env,fetcher=fetch,scope=null}={}){
  const configured=()=>!!env.CASHBARBER_URL&&String(env.CASHBARBER_SECRET||'').length>=32;
  async function call(tenant,action,input={}){
    if(!configured())throw cashError('O conector CashBarber ainda não foi configurado no servidor.',503);
    const url=new URL(env.CASHBARBER_URL);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw cashError('Configuração do conector inválida.',503);
    if(!scope)throw cashError('Conecte sua conta CashBarber para continuar.',409);
    const path='/v1/'+tenant+'/'+action,body=JSON.stringify({...input,_scope:scope});let response;
    try{response=await fetcher(new URL(path,url),{method:'POST',headers:qrHeaders(env.CASHBARBER_SECRET,'POST',path,body),body,signal:AbortSignal.timeout(['commit','change-commit'].includes(action)?115000:90000),redirect:'error'});}catch{throw cashError(action==='commit'?'Resultado não confirmado. Consulte a agenda antes de tentar outro agendamento.':'Conector CashBarber indisponível. Tente consultar novamente.',503);}
    const result=await response.json().catch(()=>({}));if(!response.ok)throw cashError(result.error||'Falha na consulta ao CashBarber.',response.status);return result;
  }
  return {configured,call,forUser:scope?undefined:user=>createCashbarberClient({env,fetcher,scope:{kind:'operator',id:user.id}}),forService:scope?undefined:()=>createCashbarberClient({env,fetcher,scope:{kind:'service'}})};
}
