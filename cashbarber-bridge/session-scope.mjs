import {cashError} from '../vercel-app/lib/cashbarber-domain.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const serviceActions=new Set(['status','login','disconnect','notification-agenda','notification-appointment','daily-subscriptions','daily-subscriber','daily-comanda-options','daily-comandas','daily-close-comanda']);
export const journalTenant=scope=>String(scope).split('_')[0];
export function resolveSessionScope(tenant,action,input){
  const scope=input?._scope;
  if(!uuid.test(tenant))throw cashError('Empresa inválida.',400);
  if(scope?.kind==='service'){
    if(!serviceActions.has(action))throw cashError('A conexão de mensagens permite somente consultas da automação.',403);
    return {key:tenant+'_service',input:{...input,_scope:undefined,...(action==='login'?{remember:true}:{})}};
  }
  if(scope?.kind!=='operator'||!uuid.test(scope.id))throw cashError('Conecte sua própria conta CashBarber.',409);
  if(action.startsWith('notification-')||action.startsWith('daily-'))throw cashError('Consulta reservada ao serviço de automação.',403);
  return {key:tenant+'_user_'+scope.id,input:{...input,_scope:undefined,...(action==='login'?{remember:false}:{})}};
}
