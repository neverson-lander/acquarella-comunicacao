import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const centralPath=resolve(root,'vercel-app/.env.qr-local'),gatewayPath=resolve(root,'whatsapp-qr-gateway/.env.qr-local');
const parse=path=>Object.fromEntries(readFileSync(path,'utf8').split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)];}));
const central=existsSync(centralPath)?parse(centralPath):null,gateway=existsSync(gatewayPath)?parse(gatewayPath):null;
if(central||gateway){
  if(!central||!gateway||central.LOCAL_QR_TEST!=='1'||central.PUBLIC_ORIGIN!=='http://127.0.0.1:3187'||gateway.APP_ORIGIN!==central.PUBLIC_ORIGIN||!central.WHATSAPP_QR_SECRET||central.WHATSAPP_QR_SECRET!==gateway.WHATSAPP_QR_SECRET||Buffer.from(central.APP_ENCRYPTION_KEY||'','base64').length!==32||Buffer.from(gateway.QR_STORAGE_KEY||'','base64').length!==32)throw Error('Configuração local existente incompleta. Preserve as chaves e revise os arquivos; não foi sobrescrito nenhum segredo.');
  console.log('Configuração local existente preservada.');
}else{
  const secret=randomBytes(32).toString('hex');
  const write=(path,values)=>writeFileSync(path,Object.entries(values).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{flag:'wx',mode:0o600});
  write(centralPath,{NODE_ENV:'development',LOCAL_QR_TEST:'1',PUBLIC_ORIGIN:'http://127.0.0.1:3187',PORT:'3187',APP_ENCRYPTION_KEY:randomBytes(32).toString('base64'),WHATSAPP_QR_URL:'http://127.0.0.1:3100',WHATSAPP_QR_SECRET:secret,CRON_SECRET:randomBytes(32).toString('hex')});
  write(gatewayPath,{NODE_ENV:'development',APP_ORIGIN:'http://127.0.0.1:3187',HOST:'127.0.0.1',PORT:'3100',QR_DATA_DIR:resolve(root,'data/qr-local-gateway'),WHATSAPP_QR_SECRET:secret,QR_STORAGE_KEY:randomBytes(32).toString('base64')});
  console.log('Configuração local criada com chaves independentes da produção.');
}
mkdirSync(resolve(root,'data/qr-local-runtime'),{recursive:true});
