import {randomBytes,randomUUID,createHash,createPublicKey,verify} from 'node:crypto';
const issuer='https://auth.openai.com',resource='https://api.openai.com/v1';
const hash=v=>createHash('sha256').update(v).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export async function verifyIdentity(token,{clientId,nonce,fetcher=fetch,now=Date.now}){
  try{
    if(typeof token!=='string'||token.length>30000)throw Error();
    const parts=token.split('.');if(parts.length!==3)throw Error();
    const header=JSON.parse(Buffer.from(parts[0],'base64url')),claims=JSON.parse(Buffer.from(parts[1],'base64url'));
    if(header.alg!=='RS256'||!header.kid)throw Error();
    const config=await fetcher(issuer+'/.well-known/openid-configuration',{signal:AbortSignal.timeout(10000)});
    if(!config.ok)throw Error();const discovery=await config.json(),uri=new URL(discovery.jwks_uri);
    if(discovery.issuer!==issuer||uri.origin!==issuer)throw Error();
    const response=await fetcher(uri,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error();
    const jwk=(await response.json()).keys?.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig'));
    if(!jwk||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw Error();
    const audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
    if(claims.iss!==issuer||!audiences.includes(clientId)||(audiences.length>1&&claims.azp!==clientId)||!Number.isFinite(claims.exp)||claims.exp<=now()/1000||claims.nonce!==nonce||typeof claims.sub!=='string'||!claims.sub)throw Error();
    return claims;
  }catch{fail('Não foi possível validar a identidade da conta ChatGPT. Inicie uma nova conexão.',401);}
}
export function createChatgptConnection({pool,seal,open,fetcher=fetch,now=Date.now,verifyToken=verifyIdentity}){
  const query=(sql,args=[])=>(pool.query(sql,args));
  async function transaction(fn){const db=await pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result;}catch(e){await db.query('rollback');throw e;}finally{db.release();}}
  async function status(tenant){const c=(await query('select email,client_id,model,guidance,state from ai_connections where tenant=$1',[tenant])).rows[0];return c?{...c,client_id:undefined}:{state:'disconnected',email:'',model:'',guidance:''};}
  async function pair(tenant){
    const token=randomBytes(32).toString('base64url');
    await transaction(async db=>{
      await db.query("insert into ai_connections(tenant,host_id,updated) values($1,$2,$3) on conflict(tenant) do nothing",[tenant,'urn:uuid:'+randomUUID(),now()]);
      await db.query('insert into ai_pairings(tenant,token_hash,expires) values($1,$2,$3) on conflict(tenant) do update set token_hash=excluded.token_hash,expires=excluded.expires,nonce=null,client_id=null,started=false',[tenant,hash(token),now()+600000]);
    });return {token,expires:now()+600000};
  }
  function pairingToken(value){if(typeof value!=='string'||!/^[\w-]{43}$/.test(value))fail('Código de conexão inválido ou expirado.',401);return hash(value);}
  async function begin(input){
    if(typeof input.nonce!=='string'||!/^[\w-]{32,100}$/.test(input.nonce))fail('Tentativa de conexão inválida.');
    const tokenHash=pairingToken(input.token);
    return transaction(async db=>{
      const p=(await db.query('select * from ai_pairings where token_hash=$1 for update',[tokenHash])).rows[0];
      if(!p||p.expires<now()||p.started)fail('Código de conexão inválido, utilizado ou expirado.',401);
      const c=(await db.query('select host_id,client_id from ai_connections where tenant=$1',[p.tenant])).rows[0];
      await db.query('update ai_pairings set nonce=$1,client_id=$2,started=true where tenant=$3',[input.nonce,c.client_id,p.tenant]);
      return {host_id:c.host_id,client_id:c.client_id||'dynamic_agent_client'};
    });
  }
  async function complete(input){
    const tokenHash=pairingToken(input.token),tokens=input.tokens;
    if(!tokens||typeof tokens.access_token!=='string'||tokens.access_token.length>30000||typeof tokens.refresh_token!=='string'||tokens.refresh_token.length>30000||tokens.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0)fail('Autorização incompleta. Inicie novamente.');
    if(typeof input.client_id!=='string'||input.client_id.length>300||input.client_id==='dynamic_agent_client')fail('Registro da aplicação incompleto.');
    const scopes=String(tokens.scope||'').split(/\s+/);if(!scopes.includes('chatgpt.tokens.use.direct'))fail('Autorize o uso do plano ChatGPT durante a conexão.');
    return transaction(async db=>{
      const p=(await db.query('select * from ai_pairings where token_hash=$1 for update',[tokenHash])).rows[0];
      if(!p||!p.started||!p.nonce||p.expires<now())fail('Código de conexão inválido ou expirado.',401);
      if(p.client_id&&p.client_id!==input.client_id)fail('O registro da conta foi alterado. Inicie novamente.',401);
      const identity=await verifyToken(tokens.id_token,{clientId:input.client_id,nonce:p.nonce,fetcher,now});
      const c=(await db.query('select * from ai_connections where tenant=$1 for update',[p.tenant])).rows[0];
      if(c.subject&&c.subject!==identity.sub)fail('Conecte a mesma conta ChatGPT já registrada nesta empresa.',409);
      const credentials={...tokens,scopes,expires_at:now()+tokens.expires_in*1000};
      await db.query("update ai_connections set client_id=$1,subject=$2,email=$3,credentials=$4,state='connected',updated=$5 where tenant=$6",[input.client_id,identity.sub,identity.email||'',seal(credentials),now(),p.tenant]);
      await db.query('delete from ai_pairings where tenant=$1',[p.tenant]);
      await db.query("update attendance_evaluations set state='pending',next_attempt=$1,error='' where tenant=$2 and state='waiting'",[now(),p.tenant]);
      return {ok:true};
    });
  }
  async function access(tenant){
    return transaction(async db=>{
      const c=(await db.query('select * from ai_connections where tenant=$1 for update',[tenant])).rows[0];
      if(!c?.credentials||c.state!=='connected')fail('Conecte sua conta ChatGPT em Configurações.',409);
      let credentials=open(c.credentials);
      if(credentials.expires_at<now()+60000){
        const response=await fetcher(issuer+'/api/accounts/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:c.client_id,refresh_token:credentials.refresh_token,resource}),signal:AbortSignal.timeout(10000)});
        if(!response.ok)fail(response.status>=500?'O ChatGPT está temporariamente indisponível.':'Reconecte sua conta ChatGPT em Configurações.',response.status>=500?503:409);
        const next=await response.json();if(!next.access_token||!Number.isFinite(next.expires_in))fail('Falha ao renovar a conexão ChatGPT.',503);
        const scopes=next.scope?String(next.scope).split(/\s+/):credentials.scopes;
        if(!scopes.includes('chatgpt.tokens.use.direct'))fail('Reconecte e autorize o uso do plano ChatGPT.',409);
        credentials={...credentials,...next,refresh_token:next.refresh_token||credentials.refresh_token,scopes,expires_at:now()+next.expires_in*1000};
        await db.query('update ai_connections set credentials=$1,updated=$2 where tenant=$3',[seal(credentials),now(),tenant]);
      }
      return {token:credentials.access_token,model:c.model};
    });
  }
  async function models(tenant){const {token}=await access(tenant);const response=await fetcher(resource+'/models',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});if(!response.ok)fail('Não foi possível consultar os modelos da conta ChatGPT.',502);const data=await response.json();return (data.models||[]).filter(m=>m.visibility==='list'&&typeof m.slug==='string').map(m=>({id:m.slug,name:m.display_name||m.slug}));}
  async function save(tenant,input){if(typeof input.model!=='string'||input.model.length>200||typeof input.guidance!=='string'||input.guidance.length>12000)fail('Modelo ou orientações inválidos.');
    if(input.model){const available=await models(tenant);if(!available.some(m=>m.id===input.model))fail('Selecione um modelo disponível na sua conta.');}
    await query('insert into ai_connections(tenant,host_id,model,guidance,updated) values($1,$2,$3,$4,$5) on conflict(tenant) do update set model=excluded.model,guidance=excluded.guidance,updated=excluded.updated',[tenant,'urn:uuid:'+randomUUID(),input.model,input.guidance,now()]);return {ok:true};}
  async function disconnect(tenant){
    let warning='';
    await transaction(async db=>{const c=(await db.query('select * from ai_connections where tenant=$1 for update',[tenant])).rows[0];
      if(c?.credentials)try{const config=await fetcher(issuer+'/.well-known/openid-configuration',{signal:AbortSignal.timeout(10000)}),discovery=await config.json(),endpoint=new URL(discovery.revocation_endpoint);if(endpoint.origin!==issuer)throw Error();const response=await fetcher(endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:open(c.credentials).refresh_token,token_type_hint:'refresh_token',client_id:c.client_id}),signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error();}catch{warning='Desconectado na central. A revogação remota não foi confirmada; confira o acesso do aplicativo nas configurações do ChatGPT.';}
      await db.query("update ai_connections set credentials=null,state='disconnected',updated=$1 where tenant=$2",[now(),tenant]);await db.query('delete from ai_pairings where tenant=$1',[tenant]);});return {ok:true,warning};
  }
  return {status,pair,begin,complete,access,models,save,disconnect};
}
