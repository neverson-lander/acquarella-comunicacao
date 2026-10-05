import test from 'node:test';
import assert from 'node:assert/strict';
import { signedReply, inboundWhatsApp, forwardingAllowed, customerProfile } from '../lib/sac.mjs';
import { createInboundHandler } from '../lib/sac-inbound.mjs';

const instagram = { id: 'ig', tenant: 'company', name: 'Acquarella', channel: 'instagram', external: 'page', mode: 'live', bridge: 'wa', forwarding_enabled: true };
const whatsapp = { id: 'wa', tenant: 'company', channel: 'whatsapp', external: 'phone-id', mode: 'live', forwarding_enabled: true };
const phone = '5534988748139';
const stamp = 1790805000000;

function harness(origin = instagram, bridgeReply = false) {
  const conversations = new Map(), messages = new Set(), calls = { queue: [], send: [], audit: [], inserted: [], updates: [] };
  if (bridgeReply) conversations.set('ig:client', { id: 'origin', tenant: 'company', account: 'ig', customer: 'client', name: 'Maria', last_inbound: stamp });
  let seq = 0;
  const one = async (sql, v) => {
    if (sql.startsWith('select id from messages')) return messages.has(v[0]) ? { id: 'existing' } : undefined;
    if (sql.startsWith('select * from conversations where account')) return conversations.get(`${v[0]}:${v[1]}`);
    if (sql.startsWith('insert into conversations')) {
      const c = { id: v[0], tenant: v[1], account: v[2], customer: v[3], name: v[4], username: v[5], profile_checked: v[6], last_inbound: v[7] };
      conversations.set(`${c.account}:${c.customer}`, c); return c;
    }
    if (sql.startsWith('insert into messages')) { if (messages.has(v[5])) return undefined; messages.add(v[5]); calls.inserted.push(v); return { id: v[0] }; }
    if (sql.startsWith('select * from accounts')) return v[0] === 'wa' ? whatsapp : origin;
    if (sql.startsWith('select * from tenants')) return { phone };
    if (sql.startsWith('select * from jobs')) return bridgeReply ? { conversation: 'origin' } : undefined;
    if (sql.startsWith('insert into receipts')) { const key=`receipt:${v[1]}`; if(messages.has(key))return undefined;messages.add(key);return{external:v[1]}; }
    if (sql.startsWith('select * from conversations where id')) return conversations.get('ig:client');
    throw new Error(`Unexpected query: ${sql}`);
  };
  const handler = createInboundHandler({ one, run: async (sql,v)=>calls.updates.push([sql,v]), id:()=>`id-${++seq}`, now:()=>stamp, open:()=>({}), profile:async()=>({name:'Maria Silva',username:'maria'}), send:async(...args)=>{calls.send.push(args);return'sent-id';}, queue:async(...args)=>calls.queue.push(args), audit:async(...args)=>calls.audit.push(args) });
  return { handler, calls, conversations };
}
const igPayload = { entry: [{ id: 'page', messaging: [{ sender: { id: 'client' }, timestamp: stamp, message: { mid: 'msg', text: 'Olá' } }] }] };
const waPayload = (from, context) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-id' }, contacts: [{ wa_id: from, profile: { name: 'Cliente WhatsApp' } }], messages: [{ from, id: 'wa-msg', timestamp: String(stamp/1000), type: 'text', text: { body: 'Recebido' }, ...(context?{context:{id:context}}:{}) }] } }] }] });

test('signed replies use the authenticated operator and enforce the provider limit', () => {
  assert.equal(signedReply('Ana\nSilva','Olá'), 'Ana Silva:\nOlá');
  assert.throws(()=>signedReply('', 'Olá'));
  assert.throws(()=>signedReply('Ana', 'x'.repeat(2000)));
});

test('forwarding respects enabled state, account ownership, live bridge and self-loop protection', () => {
  assert.equal(forwardingAllowed(instagram,whatsapp,'client',phone),true);
  assert.equal(forwardingAllowed({...instagram,forwarding_enabled:false},whatsapp,'client',phone),false);
  assert.equal(forwardingAllowed(instagram,{...whatsapp,tenant:'other'},'client',phone),false);
  assert.equal(forwardingAllowed(instagram,{...whatsapp,mode:'demo'},'client',phone),false);
  assert.equal(forwardingAllowed({...whatsapp,bridge:'wa'},whatsapp,'553488748139',phone),false);
});

test('WhatsApp payloads retain full profile name and non-text message descriptions', () => {
  const value=waPayload('5534999999999').entry[0].changes[0].value;
  assert.equal(inboundWhatsApp(value)[0].name,'Cliente WhatsApp');
  value.messages[0]={...value.messages[0],text:undefined,type:'image',image:{caption:'Documento'}};
  assert.equal(inboundWhatsApp(value)[0].body,'[Imagem] Documento');
});

test('disabled Instagram forwarding still stores messages and client identity without creating jobs', async () => {
  const h=harness({...instagram,forwarding_enabled:false});await h.handler({...instagram,forwarding_enabled:false},igPayload);
  assert.equal(h.calls.inserted.length,1);assert.equal(h.calls.queue.length,0);
  assert.equal(h.conversations.get('ig:client').name,'Maria Silva');
  assert.equal(h.conversations.get('ig:client').username,'maria');
});

test('enabled forwarding queues once even when a duplicate webhook arrives', async () => {
  const h=harness();await h.handler(instagram,igPayload);await h.handler(instagram,igPayload);
  assert.equal(h.calls.queue.length,1);assert.equal(h.calls.inserted.length,1);
});

test('WhatsApp customers outside the team are centralized instead of discarded', async () => {
  const h=harness();await h.handler(whatsapp,waPayload('5534999999999'));
  assert.equal(h.calls.inserted.length,1);assert.equal(h.calls.send.length,0);
  assert.equal(h.conversations.get('wa:5534999999999').name,'Cliente WhatsApp');
});

test('a plain team message is centralized and also opens the canonical team window', async () => {
  const h=harness();await h.handler(whatsapp,waPayload('553488748139'));
  assert.equal(h.calls.inserted.length,1);
  assert.ok(h.calls.updates.some(([sql,v])=>sql.includes('bridge_windows')&&v[1]===phone));
});

test('quoted team reply is signed and returned to the origin only once', async () => {
  const h=harness(instagram,true);await h.handler(whatsapp,waPayload('553488748139','forward-id'));await h.handler(whatsapp,waPayload('553488748139','forward-id'));
  assert.equal(h.calls.send.length,1);assert.equal(h.calls.send[0][2],'Equipe WhatsApp:\nRecebido');
});

test('disabling forwarding blocks old quoted replies and keeps them in the app', async () => {
  const h=harness({...instagram,forwarding_enabled:false},true);await h.handler(whatsapp,waPayload('553488748139','forward-id'));
  assert.equal(h.calls.send.length,0);assert.equal(h.calls.inserted.length,1);assert.equal(h.calls.audit.length,1);
});

test('an unrelated quoted sender cannot respond on behalf of the team', async () => {
  const h=harness(instagram,true);await h.handler(whatsapp,waPayload('5534999999999','forward-id'));
  assert.equal(h.calls.send.length,0);assert.equal(h.calls.inserted.length,1);
});

test('customer profile lookup is scoped to Meta and never returns credentials or provider errors', async () => {
  let url;
  const result=await customerProfile(instagram,{token:'private'},'client',async u=>{url=u;return new Response(JSON.stringify({name:'Maria',username:'maria',access_token:'private'}));});
  assert.equal(new URL(url).hostname,'graph.instagram.com');assert.deepEqual(result,{name:'Maria',username:'maria'});
  assert.deepEqual(await customerProfile(instagram,{token:'private'},'client',async()=>new Response('secret error',{status:403})),{});
});

test('expired customer window blocks quoted replies but retains the WhatsApp message', async () => {
  const h=harness(instagram,true);
  h.conversations.get('ig:client').last_inbound=stamp-86400001;
  await h.handler(whatsapp,waPayload('553488748139','forward-id'));
  assert.equal(h.calls.send.length,0);assert.equal(h.calls.inserted.length,1);
});

test('automatic profile refresh never replaces a manually identified client', async () => {
  const h=harness();
  h.conversations.set('ig:client',{id:'origin',name:'Cliente identificado',name_manual:true,profile_checked:0});
  await h.handler(instagram,igPayload);
  assert.equal(h.conversations.get('ig:client').name,'Cliente identificado');
  assert.ok(h.calls.updates.some(([sql])=>sql.includes('when name_manual then name')));
});
