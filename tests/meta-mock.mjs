// Preload exclusivo dos testes: nunca carrega no servidor normal.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
let sequence=0;
globalThis.fetch=async(url,options)=>{
 if(!/^https:\/\/graph\.(facebook|instagram)\.com\//.test(String(url)))throw Error('Destino inesperado no teste.');
 const body=JSON.parse(options.body),id='mock-delivery-'+(++sequence);
 appendFileSync(join(process.env.DATA_DIR,'meta-calls.jsonl'),JSON.stringify({url,body,id})+'\n');
 return Response.json(body.messaging_product?{messages:[{id}]}:{message_id:id});
};
