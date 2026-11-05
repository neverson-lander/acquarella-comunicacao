// Run on the computer with the browser. No ChatGPT credentials are written to disk.
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {verifyIdentity} from '../lib/chatgpt-connection.mjs';
const origin=new URL(process.argv[2]||'');
if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&origin.hostname==='127.0.0.1'))throw Error('Informe a origem HTTPS da central.');
if(origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw Error('Origem inválida.');
const prompt=createInterface({input:process.stdin,output:process.stdout});
const token=(await prompt.question('Código temporário exibido em Configurações da central: ')).trim();prompt.close();
const post=async(path,input)=>{const response=await fetch(new URL(path,origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(30000)});const result=await response.json();if(!response.ok)throw Error(result.error||'Falha na conexão.');return result;};
const nonce=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
const registration=await post('/api/ai/pairing/begin',{token,nonce});
let resolveCallback,rejectCallback;
const callback=new Promise((resolve,reject)=>{resolveCallback=resolve;rejectCallback=reject;});
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname!=='/auth/callback'){res.writeHead(404);return res.end();}
  if(url.searchParams.get('state')!==state){res.writeHead(400);return res.end('Tentativa de conexão inválida.');}
  res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'});res.end('Autorização recebida. Volte ao terminal para conferir o resultado.');
  if(url.searchParams.get('error'))rejectCallback(Error('A autorização foi recusada.'));
  else resolveCallback(url.searchParams);
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const redirect='http://127.0.0.1:'+server.address().port+'/auth/callback',authorize=new URL('https://auth.openai.com/api/accounts/authorize');
authorize.search=new URLSearchParams({client_id:registration.client_id,ext_agent_host_id:registration.host_id,...(registration.client_id==='dynamic_agent_client'?{agent_name_hint:'Acquarella Central de Comunicação'}:{}),response_type:'code',redirect_uri:redirect,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:'https://api.openai.com/v1',state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}).toString();
console.log('Abra o endereço para autorizar a Acquarella. Não informe sua senha no terminal.\n'+authorize.href);
const command=process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',authorize.href]]:process.platform==='darwin'?['open',[authorize.href]]:['xdg-open',[authorize.href]];
const child=spawn(command[0],command[1],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});
const timeout=setTimeout(()=>rejectCallback(Error('A autorização expirou. Gere um novo código na central.')),540000);
try{
  const params=await callback,clientId=params.get('client_id')||(registration.client_id==='dynamic_agent_client'?'':registration.client_id);
  if(!clientId||clientId==='dynamic_agent_client'||(registration.client_id!=='dynamic_agent_client'&&clientId!==registration.client_id)||!params.get('code'))throw Error('Registro incompleto. Inicie uma nova conexão.');
  const response=await fetch('https://auth.openai.com/api/accounts/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code:params.get('code'),code_verifier:verifier,redirect_uri:redirect,resource:'https://api.openai.com/v1'}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('Não foi possível trocar a autorização. Inicie uma nova conexão.');
  const tokens=await response.json();await verifyIdentity(tokens.id_token,{clientId,nonce});
  await post('/api/ai/pairing/complete',{token,client_id:clientId,tokens});
  console.log('Conta ChatGPT conectada. Volte a Configurações, atualize os modelos e selecione um modelo para avaliação.');
}catch(error){console.error(error.message);process.exitCode=1;}finally{clearTimeout(timeout);server.closeAllConnections();server.close();}
