import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from './store.mjs';
import {Sessions,BufferJSON} from './sessions.mjs';
import {validQrSignature} from '../vercel-app/lib/qr-protocol.mjs';

export function createGateway({sessions,store,secret}) {
  if(!secret||secret.length<32)throw Error('WHATSAPP_QR_SECRET deve ter pelo menos 32 caracteres.');
  return createServer(async(req,res)=>{
    const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
    try{
      if(req.url==='/health'&&req.method==='GET')return json({ok:true});
      let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>65536)return json({error:'Requisição muito grande.',definite:true},413);}
      if(!validQrSignature(secret,req.method,req.url,new Headers(req.headers),body))return json({error:'Não autorizado.',definite:true},401);
      const match=req.url.match(/^\/sessions\/([a-f0-9-]{36}_[a-f0-9-]{36})(?:\/(connect|disconnect|pause|resume|messages|media\/[a-f0-9-]{36}))?$/i);
      if(!match)return json({error:'Não encontrado.',definite:true},404);
      const [,id,action]=match;
      if(!action&&req.method==='GET')return json(sessions.status(id));
      if(action==='connect'&&req.method==='POST')return json(await sessions.connect(id));
      if(action==='disconnect'&&req.method==='POST')return json(await sessions.disconnect(id));
      if(['pause','resume'].includes(action)&&req.method==='POST')return json(await sessions[action](id));
      if(action==='messages'&&req.method==='POST')return json(await sessions.send(id,JSON.parse(body)));
      if(action?.startsWith('media/')&&req.method==='GET'){
        const media=store.media(id,action.split('/')[1]);if(!media)return json({error:'Anexo expirado ou indisponível.',definite:true},404);
        let start=0,end=media.bytes.length-1;const range=req.headers.range;
        if(range){const m=range.match(/^bytes=(\d*)-(\d*)$/);if(!m||(!m[1]&&!m[2]))return json({error:'Intervalo inválido.'},416);
          start=m[1]?Number(m[1]):Math.max(0,media.bytes.length-Number(m[2]));end=m[1]&&m[2]?Math.min(Number(m[2]),end):end;
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=media.bytes.length)return json({error:'Intervalo inválido.'},416);
        }
        res.writeHead(range?206:200,{'content-type':media.mime,'content-length':String(end-start+1),'cache-control':'no-store','x-content-type-options':'nosniff','accept-ranges':'bytes',...(range?{'content-range':`bytes ${start}-${end}/${media.bytes.length}`}:{})});return res.end(media.bytes.subarray(start,end+1));
      }
      return json({error:'Método inválido.',definite:true},405);
    }catch(error){return json({error:error.status?error.message:'Falha no serviço WhatsApp.',definite:error.definite!==false},error.status||500);}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const secret=process.env.WHATSAPP_QR_SECRET,origin=new URL(process.env.APP_ORIGIN||'');
  if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||(origin.protocol!=='https:'&&!(process.env.NODE_ENV!=='production'&&origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname))))throw Error('APP_ORIGIN inválida.');
  const store=new Store(resolve(process.env.QR_DATA_DIR||'data','whatsapp.sqlite'),process.env.QR_STORAGE_KEY,{replacer:BufferJSON.replacer,reviver:BufferJSON.reviver});
  const sessions=new Sessions({store,secret,origin:origin.origin});
  const server=createGateway({sessions,store,secret});
  const interval=setInterval(()=>sessions.flush().catch(()=>{}),2000),cleanup=setInterval(()=>store.cleanup(),3600000);interval.unref();cleanup.unref();
  server.listen(Number(process.env.PORT||3100),process.env.HOST||'127.0.0.1',()=>{console.log('Serviço WhatsApp QR iniciado.');sessions.restore().catch(()=>{});});
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{clearInterval(interval);clearInterval(cleanup);sessions.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),5000).unref();});
}
