import test from 'node:test';
import assert from 'node:assert/strict';
import {createMessageObserver, waitingSince, waitLabel, prioritize} from '../public/inbox-domain.mjs';

const incoming=(id,created)=>({id,direction:'in',created,body:'Olá'});
const conversation=(id,messages,assigned_to=null)=>({id,name:id,account:'a',status:'open',updated:100,last_inbound:100,messages,assigned_to});
const snapshot=(conversations,time=100)=>({tenant:{id:'company'},user:{id:'ana'},server_time:time,accounts:[{id:'a',mode:'live'}],conversations});
test('incoming notices ignore initial history and duplicate snapshots but retain bursts',()=>{
  const observer=createMessageObserver(),old=conversation('queue',[incoming('old',10)]);
  assert.deepEqual(observer.observe(snapshot([old])),[]);
  const next=conversation('queue',[incoming('old',10),incoming('new1',101),incoming('new2',102)]);
  const changes=observer.observe(snapshot([next],103));
  assert.equal(changes.length,1);assert.equal(changes[0].count,2);assert.equal(changes[0].kind,'queue');
  assert.deepEqual(observer.observe(snapshot([next],105)),[]);
});
test('only new queue messages and own open replies generate notices',()=>{
  const observer=createMessageObserver();observer.observe(snapshot([]));
  const changes=observer.observe(snapshot([
    conversation('queue',[incoming('q',101)]),
    conversation('mine',[incoming('m',101)],'ana'),
    conversation('other',[incoming('o',101)],'bia'),
    {...conversation('closed',[incoming('c',101)],'ana'),status:'resolved'},
    conversation('sent',[{id:'s',direction:'out',state:'sent',created:101}],'ana')
  ],102));
  assert.deepEqual(changes.map(c=>[c.conversation,c.kind]),[['queue','queue'],['mine','mine']]);
});
test('historical cases becoming visible after transfer do not generate fake new-message notices',()=>{
  const observer=createMessageObserver();observer.observe(snapshot([]));
  assert.deepEqual(observer.observe(snapshot([conversation('old-transfer',[incoming('old',50)],'ana')],110)),[]);
  assert.equal(observer.observe(snapshot([conversation('old-transfer',[incoming('old',50),incoming('reply',111)],'ana')],112))[0].kind,'mine');
});
test('newly created conversations and reopened queue entries are observed without duplicate notices',()=>{
  const observer=createMessageObserver();observer.observe(snapshot([{...conversation('return',[incoming('old',10)],'ana'),status:'resolved'}]));
  const changes=observer.observe(snapshot([conversation('return',[incoming('old',10),incoming('return',101)]),conversation('new',[incoming('first',102)])],103));
  assert.equal(changes.length,2);assert.ok(changes.every(c=>c.kind==='queue'));
});
test('switching tenant/user or resetting the observer establishes a fresh baseline',()=>{
  const observer=createMessageObserver();observer.observe(snapshot([]));
  const next=snapshot([conversation('q',[incoming('new',101)])],103);next.user.id='bia';
  assert.deepEqual(observer.observe(next),[]);observer.reset();assert.deepEqual(observer.observe(next),[]);
});
test('waiting time resets only after a successful reply and queue priority follows pending wait',()=>{
  const returned=conversation('return',[incoming('old',10),{direction:'out',state:'sent',created:20},incoming('return',90),{direction:'out',state:'failed',created:95}]);
  const older=conversation('older',[incoming('first',50)]);older.updated=200;
  assert.equal(waitingSince(returned),90);assert.deepEqual(prioritize([returned,older],'queue').map(c=>c.id),['older','return']);
  assert.equal(waitingSince(conversation('replied',[incoming('old',10),{direction:'out',state:'sent',created:20}])),null);
});
test('own inbox prioritizes unread cases; wait labels handle minutes, days and clock skew',()=>{
  const a=conversation('a',[]),b=conversation('b',[]);a.updated=200;
  assert.deepEqual(prioritize([a,b],'mine',new Map([['b',1]])).map(c=>c.id),['b','a']);
  assert.equal(waitLabel(100,100),'Agora');assert.equal(waitLabel(100,1800100),'30 min');assert.equal(waitLabel(100,90000100),'1 d 1 h');assert.equal(waitLabel(200,100),'Agora');
});
