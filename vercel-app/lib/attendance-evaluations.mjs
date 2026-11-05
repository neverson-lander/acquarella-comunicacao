import {randomUUID} from 'node:crypto';
import {evaluationInstructions,evaluationSchema,validateEvaluation} from './evaluation-domain.mjs';

// ChatGPT plan usage requires streaming, store:false and a full input array.
// The persistent application queue supplies asynchronous execution, not background:true.
export async function readEvaluationStream(response){
  if(!response.body)throw Error('Resposta vazia da IA.');
  const reader=response.body.getReader(),decoder=new TextDecoder(),items=new Map(),texts=new Map();let buffer='',size=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>500000)throw Error('Resposta da IA excedeu o limite.');
      buffer=(buffer+decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');let end;
      while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const raw=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!raw||raw==='[DONE]')continue;
        const event=JSON.parse(raw);
        const key=String(event.output_index??0)+':'+String(event.content_index??0);
        if(event.type==='response.output_text.delta')texts.set(key,(texts.get(key)||'')+(event.delta||''));
        if(event.type==='response.output_text.done')texts.set(key,event.text||'');
        if(event.type==='response.output_item.done'&&event.item)items.set(event.output_index,event.item);
        if(event.type==='response.failed'||event.type==='error')throw Object.assign(Error('A IA não concluiu a análise.'),{providerCode:event.response?.error?.code||event.code});
        if(event.type==='response.incomplete')throw Error('A IA não concluiu a análise.');
        if(event.type==='response.completed'){
          // With ChatGPT plan usage and store:false, the terminal response may
          // omit output. Completed output items and text events remain in SSE.
          const output=event.response?.output?.length?event.response.output:[...items.entries()].sort((a,b)=>a[0]-b[0]).map(([,item])=>item);
          const content=output.filter(o=>o.type==='message').flatMap(o=>o.content||[]);
          if(content.some(c=>c.type==='refusal'))throw Error('A IA não conseguiu avaliar este atendimento.');
          const text=content.filter(c=>c.type==='output_text').map(c=>c.text).join('')||[...texts.entries()].sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true})).map(([,text])=>text).join('');
          return JSON.parse(text);
        }
      }
    }
    throw Error('A conexão com a IA terminou antes de concluir a avaliação.');
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createEvaluationWorker({pool,connection,fetcher=fetch,now=Date.now}){
  return async function processEvaluations(){
    const lease=randomUUID(),stamp=now();
    const job=(await pool.query(`update attendance_evaluations set state='processing',lease=$1,next_attempt=$2,updated=$3 where id=(
      select id from attendance_evaluations where (state in ('pending','waiting') or state='processing') and next_attempt<=$3
      order by next_attempt,created,id for update skip locked limit 1) returning *`,[lease,stamp+300000,stamp])).rows[0];
    if(!job)return {processed:0};
    const finish=(state,error,result=null,model='',delay=0,attempt=false)=>pool.query(`update attendance_evaluations set state=$1,error=$2,result=$3,score=$4,model=$5,updated=$6,next_attempt=$7,attempts=attempts+$8,lease=null where id=$9 and lease=$10`,[state,error,result?JSON.stringify(result):null,result?.score??null,model,now(),now()+delay,attempt?1:0,job.id,lease]);
    let model='';
    try{
      const account=(await pool.query('select enabled,deleted_at,evaluation_enabled from accounts where id=$1 and tenant=$2',[job.account,job.tenant])).rows[0];
      if(!account||!account.enabled||account.deleted_at||!account.evaluation_enabled){await finish('cancelled','Avaliação ou canal desativado antes do processamento.');return {processed:1};}
      const access=await connection.access(job.tenant);model=access.model;
      if(!model){await finish('waiting','Selecione o modelo da IA em Configurações.',null,'',300000);return {processed:1};}
      const response=await fetcher('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+access.token,'content-type':'application/json'},signal:AbortSignal.timeout(40000),body:JSON.stringify({model,store:false,stream:true,instructions:evaluationInstructions,input:[{role:'user',content:JSON.stringify(job.snapshot)}],text:{format:{type:'json_schema',name:'attendance_evaluation',strict:true,schema:evaluationSchema}}})});
      if(!response.ok){const data=await response.json().catch(()=>({}));throw Object.assign(Error('Falha na avaliação automática.'),{status:response.status,providerCode:data.error?.code});}
      const result=validateEvaluation(await readEvaluationStream(response),job.snapshot);
      // Revoking the local connection or disabling a channel while a request runs
      // prevents its result from being published.
      const active=(await pool.query("select a.evaluation_enabled,a.enabled,a.deleted_at,c.state from accounts a join ai_connections c on c.tenant=a.tenant where a.id=$1 and a.tenant=$2",[job.account,job.tenant])).rows[0];
      if(!active?.evaluation_enabled||!active.enabled||active.deleted_at||active.state!=='connected')await finish('cancelled','Conexão ou avaliação desativada durante o processamento.');
      else await finish('completed','',result,model,0,true);
    }catch(error){
      const usage=['subscription_sharing_usage_limit_exceeded','subscription_sharing_usage_unavailable'].includes(error.providerCode);
      if([401,403,409].includes(error.status))await finish('waiting','Reconecte a conta e confira a permissão de uso do plano ChatGPT.',null,model,300000);
      else if(error.status===429||usage)await finish('waiting','Limite do ChatGPT indisponível. Nova tentativa em 30 minutos.',null,model,1800000);
      else if(job.attempts>=2)await finish('failed','Não foi possível concluir após três tentativas. Solicite uma nova análise.',null,model,0,true);
      else await finish('pending','Análise temporariamente indisponível. Nova tentativa automática.',null,model,60000*(job.attempts+1),true);
    }
    return {processed:1};
  };
}
