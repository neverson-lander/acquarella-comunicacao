import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,sep,extname} from 'node:path';
import {Readable} from 'node:stream';
import {createLocalPool} from '../lib/local-database.mjs';

if(process.env.NODE_ENV!=='development'||process.env.LOCAL_QR_TEST!=='1')throw Error('Use o iniciador do ambiente local de testes.');
const port=Number(process.env.PORT||3187),origin=`http://127.0.0.1:${port}`;
if(process.env.PUBLIC_ORIGIN!==origin||process.env.WHATSAPP_QR_URL!=='http://127.0.0.1:3100')throw Error('Origens locais de teste inválidas.');
// Never inherit credentials for real social channels from a parent terminal.
for(const key of ['DATABASE_URL','POSTGRES_URL','META_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_VERIFY_TOKEN','MESSENGER_PAGE_TOKEN','MESSENGER_VERIFY_TOKEN','ACQUARELLA_MIGRATION_DATA'])delete process.env[key];
const directory=fileURLToPath(new URL('../../data/qr-local-central/',import.meta.url));
const pool=await createLocalPool(directory);globalThis.__acquarellaPool=pool;
const {default:app}=await import('../api/index.mjs');
const publicDirectory=resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.webp':'image/webp','.json':'application/json'};
const policy="default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: blob: https://*.fbcdn.net https://*.cdninstagram.com; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'";
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname==='/health'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end('{"ok":true,"environment":"local-qr-test"}');}
    if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/webhooks/')){
      const body=!['GET','HEAD'].includes(req.method)?Readable.toWeb(req):undefined;
      const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(', '):value);
      const response=await app.fetch(new Request(url,{method:req.method,headers,...(body?{body,duplex:'half'}:{})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));if(!response.body)return res.end();
      Readable.fromWeb(response.body).on('error',()=>res.destroy()).pipe(res);return;
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
    const aliases={'/':'index.html','/privacidade':'privacy.html','/exclusao-de-dados':'data-deletion.html'};
    const path=resolve(publicDirectory,aliases[url.pathname]||'.'+decodeURIComponent(url.pathname));
    if(!path.startsWith(publicDirectory+sep)&&path!==resolve(publicDirectory,'index.html')){res.writeHead(404);return res.end();}
    const bytes=await readFile(path);
    res.writeHead(200,{'content-type':types[extname(path)]||'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':policy,'referrer-policy':'same-origin'});
    res.end(req.method==='HEAD'?undefined:bytes);
  }catch(error){if(res.headersSent){res.destroy();return;}res.writeHead(error.code==='ENOENT'?404:500,{'content-type':'text/plain; charset=utf-8'});res.end(error.code==='ENOENT'?'Não encontrado.':'Falha no servidor local. Confira o log.');console.error(error);}
});
let processingAlerts=false;
const interval=setInterval(async()=>{
  if(processingAlerts)return;processingAlerts=true;
  try{const response=await app.fetch(new Request(origin+'/api/internal/waiting-alerts',{headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`}}));await response.body?.cancel();}
  catch{console.error('Falha na verificação local de alertas.');}finally{processingAlerts=false;}
},60000);interval.unref();
server.listen(port,'127.0.0.1',()=>console.log(`Central local de teste iniciada: ${origin}`));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{clearInterval(interval);server.close(async()=>{await pool.end();process.exit(0);});setTimeout(()=>process.exit(0),5000).unref();});
