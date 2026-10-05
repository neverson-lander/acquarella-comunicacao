import {readFileSync} from 'node:fs';
const auth=JSON.parse(readFileSync(process.env.APPDATA+'\\com.vercel.cli\\Data\\auth.json','utf8'));
const team='team_cnt13inqzV5W6SSLOwf4Xe4w';
const project='prj_jwX1V15zyvPVcqTWoBtFkWlDwpBZ';
const headers={Authorization:`Bearer ${auth.token}`};
const integration=await (await fetch(`https://api.vercel.com/v2/integrations/integration/supabase?teamId=${team}`,{headers})).json();
if(!integration.id) throw new Error('Integração Supabase não encontrada.');
const products=integration.products||integration.products?.items||[];
const product=Array.isArray(products)?products.find(p=>p.slug==='supabase'||p.name?.toLowerCase().includes('supabase')):null;
if(!product?.id){console.error(JSON.stringify({keys:Object.keys(integration),id:integration.id,productKeys:Array.isArray(products)?products.map(p=>({id:p.id,slug:p.slug,name:p.name})):typeof products}));process.exit(2)}
const u=new URL('https://vercel.com/api/marketplace/cli');
for(const [k,v] of Object.entries({teamId:team,integrationId:integration.id,productId:product.id,projectId:project,cmd:'add'}))u.searchParams.set(k,v);
console.log(u.href);
