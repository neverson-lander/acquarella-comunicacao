import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,sep,extname} from 'node:path';
import {Readable} from 'node:stream';
import {timingSafeEqual} from 'node:crypto';
import {pool} from '../lib/database.mjs';

const origin=new URL(process.env.PUBLIC_ORIGIN||'');
if(process.env.DEPLOYMENT_MODE!=='standalone'||process.env.NODE_ENV!=='production'||origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Configuração da aplicação independente inválida.');
if(Buffer.from(process.env.APP_ENCRYPTION_KEY||'','base64').length!==32||process.env.CRON_SECRET?.length<32||!process.env.CRON_SECRET)throw Error('Chaves da aplicação inválidas.');
const {default:app}=await import('../api/index.mjs');
const directory=resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.webp':'image/webp','.json':'application/json'};
const security={'x-content-type-options':'nosniff','referrer-policy':'same-origin','content-security-policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: blob: https://*.fbcdn.net https://*.cdninstagram.com; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'"};
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.origin!==origin.origin){res.writeHead(400);return res.end();}
    const setupToken=process.env.INITIAL_SETUP_TOKEN||'';
    const validSetupToken=value=>setupToken.length>=48&&typeof value==='string'&&Buffer.byteLength(value)===Buffer.byteLength(setupToken)&&timingSafeEqual(Buffer.from(value),Buffer.from(setupToken));
    if(url.pathname.startsWith('/initial-setup/')&&req.method==='GET'){
      if(!validSetupToken(url.pathname.slice('/initial-setup/'.length))){res.writeHead(404);return res.end();}
      res.writeHead(303,{'location':'/','cache-control':'no-store','referrer-policy':'no-referrer','set-cookie':`initial_setup=${setupToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`});return res.end();
    }
    if(url.pathname==='/api/setup'&&!validSetupToken((req.headers.cookie||'').match(/(?:^|; )initial_setup=([^;]+)/)?.[1])){
      res.writeHead(403,{'content-type':'application/json','cache-control':'no-store'});return res.end('{"error":"Abra o acesso privado de configuração inicial para criar o administrador."}');
    }
    if(url.pathname==='/health'&&req.method==='GET'){
      await pool.query('select 1');res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end('{"ok":true}');
    }
    if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/webhooks/')){
      const body=!['GET','HEAD'].includes(req.method)?Readable.toWeb(req):undefined;
      const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(', '):value);
      // Never trust a client-provided Vercel header on this deployment.
      headers.delete('x-vercel-forwarded-for');
      const response=await app.fetch(new Request(url,{method:req.method,headers,...(body?{body,duplex:'half'}:{})}));
      const output={...security,...Object.fromEntries(response.headers)};
      if(response.headers.getSetCookie().length)output['set-cookie']=response.headers.getSetCookie();
      if(url.pathname==='/api/setup'&&response.ok)output['set-cookie']=[...(output['set-cookie']||[]),'initial_setup=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'];
      res.writeHead(response.status,output);
      if(!response.body||req.method==='HEAD'){await response.body?.cancel();return res.end();}
      Readable.fromWeb(response.body).on('error',()=>res.destroy()).pipe(res);return;
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
    const aliases={'/':'index.html','/privacidade':'privacy.html','/exclusao-de-dados':'data-deletion.html'};
    const decoded=decodeURIComponent(url.pathname);
    if(decoded.split('/').some(part=>part.startsWith('.'))){res.writeHead(404);return res.end();}
    const path=resolve(directory,aliases[decoded]||'.'+decoded);
    if(!path.startsWith(directory+sep)){res.writeHead(404);return res.end();}
    const bytes=await readFile(path);
    res.writeHead(200,{...security,'content-type':types[extname(path)]||'application/octet-stream','cache-control':'no-cache'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(error){
    if(res.headersSent){res.destroy();return;}
    const missing=error.code==='ENOENT'||error.code==='EISDIR';
    res.writeHead(missing?404:500,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end(missing?'Não encontrado.':'Falha no servidor.');
    if(!missing)console.error('Falha HTTP:',error.code||error.name);
  }
});
server.requestTimeout=65000;server.headersTimeout=15000;
const enabled=process.env.RUN_WAITING_ALERTS==='1';
globalThis.__acquarellaSchedulerStatus={scheduled:enabled,schedule:'* * * * *',latest:null};
let processing=false;
const interval=setInterval(async()=>{
  if(!enabled||processing)return;processing=true;const created=new Date().toISOString();
  try{
    const response=await app.fetch(new Request(new URL('/api/internal/waiting-alerts',origin),{headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`},signal:AbortSignal.timeout(55000)}));
    await response.body?.cancel();globalThis.__acquarellaSchedulerStatus.latest={created,status_code:response.status,timed_out:false,error_msg:null};
    if(!response.ok)console.error('Verificação de alertas: HTTP',response.status);
  }catch{globalThis.__acquarellaSchedulerStatus.latest={created,status_code:null,timed_out:true,error_msg:'Falha na execução'};console.error('Falha na verificação de alertas.');}
  finally{processing=false;}
},60000);interval.unref();
await pool.query('select 1');
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log('Central independente iniciada.'));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{clearInterval(interval);server.close(async()=>{await pool.end();process.exit(0);});setTimeout(()=>process.exit(0),10000).unref();});
