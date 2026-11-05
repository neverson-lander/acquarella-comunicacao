import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeInboxSnapshot} from '../public/inbox-snapshot.mjs';

test('incremental inbox retains unchanged closed history, updates changed cases and removes revoked access',()=>{
  const base={user:{id:'a'},tenant:{id:'t'},conversations:[{id:'closed',status:'resolved',updated:1,messages:[{body:'Histórico'}]},{id:'open',updated:2},{id:'revoked',updated:3}]};
  const next={user:{id:'a'},tenant:{id:'t'},partial:true,visible_conversation_ids:['closed','open'],conversations:[{id:'open',updated:4,messages:[{body:'Nova mensagem'}]}]};
  const merged=mergeInboxSnapshot(base,next);
  assert.deepEqual(merged.conversations.map(c=>c.id),['open','closed']);
  assert.equal(merged.conversations[1].messages[0].body,'Histórico');
  assert.equal(merged.conversations[0].messages[0].body,'Nova mensagem');
  assert.equal(mergeInboxSnapshot(base,{...next,user:{id:'other'}}).conversations.length,1);
  assert.equal(mergeInboxSnapshot(base,{...next,tenant:{id:'other'}}).conversations.length,1);
});
