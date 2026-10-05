import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
const project=JSON.parse(readFileSync('vercel-app/.vercel/project.json','utf8'));
const auth=JSON.parse(readFileSync(process.env.APPDATA+'/com.vercel.cli/Data/auth.json','utf8'));
const base=`https://api.vercel.com/v10/projects/${project.projectId}/env?teamId=${project.orgId}`;
const headers={Authorization:`Bearer ${auth.token}`,'content-type':'application/json'};
const current=await (await fetch(base,{headers})).json();
if(!current.envs)throw Error('Não foi possível consultar as variáveis da Vercel.');
const file='vercel-app/.env.alert-cron.local';
if(current.envs.some(e=>e.key==='CRON_SECRET'&&e.target.includes('production'))){
  if(!existsSync(file))throw Error('CRON_SECRET já existe; obtenha-o pelo fluxo de credenciais existente para verificar o agendador.');
  console.log('CRON_SECRET existente preservado.');
}else{
  const secret=randomBytes(32).toString('hex');
  const result=await fetch(base,{method:'POST',headers,body:JSON.stringify({key:'CRON_SECRET',value:secret,type:'sensitive',target:['production']})});
  if(!result.ok)throw Error(`Configuração de CRON_SECRET recusada: HTTP ${result.status}`);
  writeFileSync(file,`CRON_SECRET=${secret}\n`);
  console.log('Autorização do agendador configurada como segredo de produção.');
}
