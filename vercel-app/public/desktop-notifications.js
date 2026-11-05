import {conversationAttention,waitLabel,suppressConversationPush} from './inbox-domain.mjs';
export function createDesktopNotifications({getState,openConversation,toast,onPermissionWarning=toast,onChange=()=>{},NotificationClass=globalThis.Notification,storage=globalThis.localStorage,locks=globalThis.navigator?.locks,focus=()=>globalThis.window?.focus(),now=Date.now}){
 const active=new Map();let generation=0,lastPermissionIdentity=null,lastPermissionCheck=0;
 const identity=state=>state?.user?.id&&state?.tenant?.id?state.tenant.id+':'+state.user.id:null;
 const key=state=>'acquarella:desktop:'+identity(state);
 const read=state=>{try{const value=JSON.parse(storage.getItem(key(state))||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}};
 const write=(state,value)=>{try{storage.setItem(key(state),JSON.stringify(value));}catch{}};
 const supported=()=>typeof NotificationClass==='function'&&globalThis.isSecureContext!==false;
 function status(){const state=getState(),required=!!identity(state)&&state.user.role!=='admin',permission=NotificationClass?.permission||'default',wanted=required||read(state).enabled===true;return {supported:supported(),permission,required,enabled:!!identity(state)&&wanted&&supported()&&permission==='granted',needsPermission:!!identity(state)&&wanted&&(!supported()||permission!=='granted')};}
 function checkPermission({force=false}={}){const user=identity(getState());if(!user)return;const time=now();if(!force&&lastPermissionIdentity===user&&time-lastPermissionCheck<120000)return;lastPermissionIdentity=user;lastPermissionCheck=time;onChange();const current=status();if(current.needsPermission)onPermissionWarning(!current.supported?'Notificações obrigatórias indisponíveis neste navegador. Use a central por HTTPS no Chrome ou Edge.':current.permission==='denied'?'Libere as notificações deste site nas configurações do navegador.':'Permita as notificações do navegador para receber os avisos obrigatórios da central.');}
 function reset(){generation++;lastPermissionIdentity=null;lastPermissionCheck=0;for(const item of active.values())item.notification.close();active.clear();onChange();}
 function show(title,body,tag,conversation,options={}){
  const previous=active.get(tag);previous?.notification.close();
  const notification=new NotificationClass(title,{body,tag,icon:'/acquarella-logo.png',requireInteraction:true,...options});
  active.set(tag,{notification,conversation});
  notification.onclick=()=>{notification.close();focus();if(conversation)openConversation(conversation);};
  notification.onclose=()=>{if(active.get(tag)?.notification===notification)active.delete(tag);};return notification;
 }
 async function toggle(){
  const state=getState(),user=identity(state);if(!user)return;
  if(!supported())return toast('Este navegador não oferece avisos do computador. Abra a central por HTTPS no Chrome ou Edge.');
  if(status().enabled){if(status().required){toast('As notificações são obrigatórias para seu perfil.');return;}write(state,{...read(state),enabled:false});reset();toast('Avisos do computador pausados neste navegador.');return;}
  if(NotificationClass.permission==='denied')return toast('As notificações estão bloqueadas. Libere a permissão nas configurações deste site no navegador.');
  try{const permission=NotificationClass.permission==='granted'?'granted':await NotificationClass.requestPermission();
   if(identity(getState())!==user)return;
   if(permission!=='granted'){onChange();toast(permission==='denied'?'Notificações bloqueadas pelo navegador.':'Permissão não concedida. Você pode ativar os avisos depois.');return;}
   write(state,{...read(state),enabled:true});onChange();toast('Avisos do computador ativados. Mantenha a central aberta, mesmo minimizada.');await sync(getState(),[]);
  }catch{toast('Não foi possível ativar as notificações neste navegador.');}
 }
 function test(){if(!status().enabled)return;try{show('Acquarella · Avisos ativados','Você receberá avisos de mensagens e de atendimentos que precisam de atenção.','acquarella-test:'+identity(getState()));}catch{toast('O navegador não conseguiu exibir o aviso. Confira a permissão de notificações do site e do computador.');}}
 const attentionKey=({c,a})=>[c.assigned_to||'queue',a.since,a.minutes].join(':');
 function showAttention(items,user,silent=false){
  const names=items.slice(0,3).map(({c,a})=>c.name+' · '+waitLabel(a.since,now())+' sem movimentação'+(c.assignee_name?' ('+c.assignee_name+')':'')),tag='acquarella-attention:'+user;
  show('Acquarella · '+items.length+' atendimento(s) precisam de atenção',names.join('\n')+(items.length>3?'\nE mais '+(items.length-3)+' atendimento(s).':''),tag,items[0].c.id,{silent});
  active.get(tag).pending=items.map(item=>({id:item.c.id,key:attentionKey(item)}));
 }
 async function sync(state,changes=[]){
  checkPermission();onChange();if(!status().enabled||identity(state)!==identity(getState()))return new Set();
  const epoch=generation,user=identity(state);
  const work=()=>{
   if(epoch!==generation||user!==identity(getState())||!status().enabled)return new Set();
   const handled=new Set();
   const record=read(state),seen=record.seen&&typeof record.seen==='object'&&!Array.isArray(record.seen)?record.seen:{},allowed=new Set(state.conversations.filter(c=>c.status==='open'&&c.attendance_eligible!==false&&!suppressConversationPush(c,state.user)).map(c=>c.id));
   for(const id of Object.keys(seen))if(!allowed.has(id))delete seen[id];
   for(const [tag,item]of active)if(!item.pending&&item.conversation&&!allowed.has(item.conversation)){item.notification.close();active.delete(tag);}
   for(const change of changes){if(!allowed.has(change.conversation))continue;if(seen[change.conversation]?.message===change.message?.id){handled.add(change.conversation);continue;}
    try{const title=change.kind==='queue'?'Nova mensagem na fila':change.message?.direction==='out'?'Mensagem enviada no atendimento':'Nova mensagem em atendimento';
     show('Acquarella · '+title,change.name+(change.owner?' · Responsável: '+change.owner:'')+'. Clique para abrir.','acquarella-message:'+user+':'+change.conversation,change.conversation);
     seen[change.conversation]={...seen[change.conversation],message:change.message.id};
     handled.add(change.conversation);
    }catch{onChange();}
   }
   const overdue=state.conversations.filter(c=>allowed.has(c.id)).map(c=>({c,a:conversationAttention(c,state.accounts.find(a=>a.id===c.account),now())})).filter(({a})=>a.overdue).sort((a,b)=>a.a.since-b.a.since);
   const tag='acquarella-attention:'+user,current=active.get(tag),pending=current?.pending||[];
   const remaining=overdue.filter(item=>pending.some(p=>p.id===item.c.id&&p.key===attentionKey(item)));
   const fresh=overdue.filter(item=>seen[item.c.id]?.idle!==attentionKey(item));
   const items=overdue.filter(item=>remaining.includes(item)||fresh.includes(item));
   if(fresh.length||remaining.length!==pending.length){
    if(items.length){try{showAttention(items,user,!fresh.length);for(const item of fresh)seen[item.c.id]={...seen[item.c.id],idle:attentionKey(item)};}catch{onChange();}}
    else{current?.notification.close();active.delete(tag);}
   }
   write(state,{...record,seen});
   return handled;
  };
  if(locks?.request)return await locks.request('acquarella-desktop:'+user,work);return work();
 }
 function readConversation(id){for(const [tag,item]of active)if(item.conversation===id&&tag.startsWith('acquarella-message:')){item.notification.close();active.delete(tag);}}
 return {status,toggle,test,sync,reset,checkPermission,read:readConversation};
}
