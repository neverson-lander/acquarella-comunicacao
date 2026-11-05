import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {validQrSignature} from '../vercel-app/lib/qr-protocol.mjs';
import {CashApi} from './api.mjs';
import {createVault} from './vault.mjs';
import {resolveSessionScope} from './session-scope.mjs';
const secret=process.env.CASHBARBER_SECRET||'';if(secret.length<32)throw Error('CASHBARBER_SECRET não configurado.');
const vault=createVault(process.env.CASHBARBER_DATA_DIR||'./data',Buffer.from(process.env.CASHBARBER_STORAGE_KEY||'','base64'));
const browser=await chromium.launch({headless:true}),cash=new CashApi(browser,vault);
const server=createServer(async(req,res)=>{
  const respond=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  if(req.url==='/health'&&req.method==='GET')return respond(browser.isConnected()?200:503,{ok:browser.isConnected()});
  try{
    const match=req.url.match(/^\/v1\/([a-f0-9-]{36})\/(status|login|disconnect|clients|client|customer-page|create-client|appointments|upcoming-appointments|appointment|change-preview|change-commit|change-reconcile|campaign-bookings|campaign-auto-bookings|daily-subscriptions|daily-subscriber|daily-comanda-options|daily-comandas|daily-close-comanda|notification-agenda|notification-appointment|professionals|services|week-day|preview|commit|reconcile)$/i);
    if(!match||req.method!=='POST')return respond(404,{error:'Não encontrado.'});
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384)return respond(413,{error:'Conteúdo muito grande.'});chunks.push(chunk);}
    const raw=Buffer.concat(chunks).toString();if(!validQrSignature(secret,'POST',req.url,new Headers(req.headers),raw))return respond(401,{error:'Não autorizado.'});
    const scoped=resolveSessionScope(match[1],match[2],JSON.parse(raw));respond(200,await cash.perform(scoped.key,match[2],scoped.input));
  }catch(error){respond(error.status||502,{error:error.status?error.message:'Falha ao consultar a API CashBarber. Reconecte ou tente novamente.'});}
});
server.requestTimeout=120000;server.headersTimeout=10000;
server.listen(Number(process.env.PORT||3200),process.env.HOST||'127.0.0.1');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close();browser.close().finally(()=>process.exit());});
