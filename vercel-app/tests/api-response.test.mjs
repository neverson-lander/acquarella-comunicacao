import test from 'node:test';
import assert from 'node:assert/strict';
import {readApiResponse} from '../public/api-response.mjs';

test('empty proxy errors preserve HTTP status so bulk processing pauses on the current customer',async()=>{
  for(const status of [502,503,504])await assert.rejects(readApiResponse(new Response('',{status})),e=>e.status===status&&/temporariamente indisponível/.test(e.message)&&!e.message.includes('JSON'));
  await assert.rejects(readApiResponse(new Response('<html>Bad Gateway</html>',{status:502})),e=>e.status===502);
});
test('truncated or invalid successful responses become recoverable gateway failures',async()=>{
  for(const body of ['','{"matches":','null','"unexpected"'])await assert.rejects(readApiResponse(new Response(body)),e=>e.status===502);
  await assert.rejects(readApiResponse({ok:true,status:200,json:async()=>{throw TypeError('terminated');}}),e=>e.status===502);
});
test('valid results and meaningful API errors remain available to the caller',async()=>{
  const result={status:'matched',matches:[{id:'90'}],saved:true};
  assert.deepEqual(await readApiResponse(Response.json(result)),result);
  const response=Response.json({error:'Sessão expirada'},{status:409});
  assert.deepEqual(await readApiResponse(response),{error:'Sessão expirada'});assert.equal(response.status,409);
});
