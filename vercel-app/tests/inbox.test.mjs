import test from 'node:test';
import assert from 'node:assert/strict';
import {attendanceStatus,filterAttendanceConversations,createMessageObserver, waitingSince, waitLabel, prioritize,queueWaitingSince,conversationWaitingSince,lastConversationMessage,conversationAttention,scopeIndicators,visualAlertMinutes,suppressConversationPush} from '../public/inbox-domain.mjs';

const incoming=(id,created)=>({id,direction:'in',created,body:'Olá'});
const conversation=(id,messages,assigned_to=null)=>({id,name:id,account:'a',status:'open',updated:100,last_inbound:100,messages,assigned_to});
const snapshot=(conversations,time=100)=>({tenant:{id:'company'},user:{id:'ana'},server_time:time,accounts:[{id:'a',mode:'live'}],conversations});

test('outgoing follow-up keeps its timer, uses a separate indicator, and suppresses push only for the owner',()=>{
 const now=Date.now(),sent={id:'out',direction:'out',state:'sent',created:now-20*60000};
 const mine=conversation('mine',[incoming('in',now-30*60000),sent],'ana'),account={id:'a',visual_alert_minutes:10};
 const attention=conversationAttention(mine,account,now);assert.equal(attention.overdue,true);assert.equal(attention.followUp,true);assert.equal(attention.since,sent.created);assert.equal(waitLabel(attention.since,now),'20 min');
 assert.equal(suppressConversationPush(mine,{id:'ana'}),true);assert.equal(suppressConversationPush(mine,{id:'bia'}),false);
 const state={...snapshot([mine]),accounts:[account]};assert.deepEqual(scopeIndicators(state,'mine',new Map(),now),{total:1,unread:0,attention:0,followUp:1});
 for(const state of ['queued','failed','uncertain','simulated']){const pending={...mine,messages:[mine.messages[0],{...sent,state}]};assert.equal(suppressConversationPush(pending,{id:'ana'}),false);assert.equal(conversationAttention(pending,account,now).followUp,false);}
 const answered={...mine,messages:[...mine.messages,incoming('new',now-15*60000)]};assert.equal(suppressConversationPush(answered,{id:'ana'}),false);assert.equal(conversationAttention(answered,account,now).followUp,false);
 assert.equal(suppressConversationPush({...mine,status:'resolved'},{id:'ana'}),false);
 assert.equal(suppressConversationPush({...mine,assigned_to:null},{id:'ana'}),false);
});

test('assigned attention follows the last received or successful sent message and the channel threshold',()=>{
 const now=Date.now(),old=now-60*60000,recent=now-5*60000;
 const c={...conversation('owned',[incoming('in',old),{id:'out',direction:'out',state:'sent',created:recent}],'ana'),updated:now};
 assert.equal(lastConversationMessage(c).id,'out');assert.equal(conversationAttention(c,{visual_alert_minutes:10},now).overdue,false);
 assert.equal(conversationAttention(c,{visual_alert_minutes:5},now).overdue,true);
 const repliedFirst={...c,messages:[c.messages[1],incoming('last',now-1000)]};assert.equal(lastConversationMessage(repliedFirst).id,'last');
 for(const state of ['queued','uncertain','failed','simulated'])assert.equal(lastConversationMessage({...c,messages:[c.messages[0],{...c.messages[1],state}]}).id,'in');
 assert.equal(lastConversationMessage({...c,messages:[c.messages[0],{...c.messages[1],kind:'reaction'}]}).id,'in');
 assert.equal(conversationAttention({...c,updated:now+1e9},{visual_alert_minutes:5},now).overdue,true);
 for(const extra of [{status:'resolved'},{attendance_eligible:false}])assert.equal(conversationAttention({...c,...extra},{visual_alert_minutes:1},now).overdue,false);
 for(const account of [{enabled:false},{deleted_at:now}])assert.equal(conversationAttention(c,{...account,visual_alert_minutes:1},now).overdue,false);
 assert.equal(conversationAttention({...c,messages:[]},{},now).overdue,false);
 assert.equal(visualAlertMinutes({}),30);assert.equal(visualAlertMinutes({visual_alert_minutes:0}),30);
});
test('queue and assigned attention use independent deadlines on the same channel',()=>{
 const now=Date.now(),account={visual_alert_minutes:30,visual_queue_minutes:5,visual_assigned_minutes:45},message=incoming('last',now-20*60000);
 const queue=conversation('queue',[message]),assigned=conversation('assigned',[message],'ana');
 assert.equal(conversationAttention(queue,account,now).overdue,true);assert.equal(conversationAttention(queue,account,now).minutes,5);
 assert.equal(conversationAttention(assigned,account,now).overdue,false);assert.equal(conversationAttention(assigned,account,now).minutes,45);
 assert.equal(conversationAttention(assigned,account,now+25*60000).overdue,true);
});
test('tab indicators summarize each open scope, new activity and attention per channel',()=>{
 const now=Date.now(),a=conversation('mine',[incoming('m',now-20*60000)],'ana'),b=conversation('other',[incoming('o',now-20*60000)],'bia'),q=conversation('q',[incoming('q',now-20*60000)]);
 b.account='b';const closed={...a,id:'closed',status:'resolved'},social={...q,id:'social',attendance_eligible:false};
 const state=snapshot([a,b,q,closed,social]);state.accounts=[{id:'a',visual_alert_minutes:10},{id:'b',visual_alert_minutes:30}];
 const unread=new Map([['mine',2],['other',1],['closed',3]]);
 assert.deepEqual(scopeIndicators(state,'mine',unread,now),{total:1,unread:1,attention:1,followUp:0});
 assert.deepEqual(scopeIndicators(state,'queue',unread,now),{total:1,unread:0,attention:1,followUp:0});
 assert.deepEqual(scopeIndicators(state,'all',unread,now),{total:4,unread:2,attention:0,followUp:0});
});
test('assigned external outgoing updates alert once when delivery succeeds and do not notify on history',()=>{
 const observer=createMessageObserver(),initial=conversation('mine',[incoming('old',10)],'ana');observer.observe(snapshot([initial]));
 const queued={id:'phone',direction:'out',created:101,state:'queued',operator_id:null};
 assert.deepEqual(observer.observe(snapshot([{...initial,messages:[...initial.messages,queued]}],102)),[]);
 const next={...initial,messages:[...initial.messages,{...queued,state:'sent'}]};const changes=observer.observe(snapshot([next],103));
 assert.equal(changes.length,1);assert.equal(changes[0].message.direction,'out');assert.equal(changes[0].kind,'mine');assert.deepEqual(observer.observe(snapshot([next],104)),[]);
 assert.deepEqual(observer.observe(snapshot([{...next,status:'resolved',messages:[...next.messages,incoming('closed',105)]}],106)),[]);
});
test('claiming a queue conversation does not notify again about its historical phone reply',()=>{
 const observer=createMessageObserver(),c=conversation('claim',[incoming('old',10),{id:'old-phone',direction:'out',state:'sent',created:20}]);
 observer.observe(snapshot([c]));assert.deepEqual(observer.observe(snapshot([{...c,assigned_to:'ana'}],110)),[]);
});

test('queue wait survives absent/invalid inbound timestamps and uses queue reentry consistently',()=>{
  const now=Date.parse('2026-10-20T14:00:00-03:00'),start=now-25*60000;
  const empty={...conversation('empty',[]),updated:start,last_inbound:0};
  assert.equal(queueWaitingSince(empty),start);assert.equal(waitLabel(conversationWaitingSince(empty),now),'25 min');
  assert.equal(waitingSince(empty),null);
  assert.equal(queueWaitingSince({...empty,messages:[incoming('invalid','invalid'),incoming('zero',0)]}),start);
  assert.equal(waitLabel(NaN,now),'Sem espera pendente');
  const returned={...empty,last_inbound:start-86400000,attendance_history:[{action:'Transferido para a fila',next_owner:null,created:now-300000}]};
  assert.equal(queueWaitingSince(returned),now-300000);assert.equal(waitLabel(queueWaitingSince(returned),now),'5 min');
  assert.equal(prioritize([returned,empty],'queue')[0].id,'empty');
  assert.equal(queueWaitingSince({...empty,last_inbound:null,updated:null}),null);
});
test('incoming notices ignore initial history and duplicate snapshots but retain bursts',()=>{
  const observer=createMessageObserver(),old=conversation('queue',[incoming('old',10)]);
  assert.deepEqual(observer.observe(snapshot([old])),[]);
  const next=conversation('queue',[incoming('old',10),incoming('new1',101),incoming('new2',102)]);
  const changes=observer.observe(snapshot([next],103));
  assert.equal(changes.length,1);assert.equal(changes[0].count,2);assert.equal(changes[0].kind,'queue');
  assert.deepEqual(observer.observe(snapshot([next],105)),[]);
});
test('authorized assigned attendances include colleague updates and suppress the current operator own sends',()=>{
  const observer=createMessageObserver();observer.observe(snapshot([]));
  const changes=observer.observe(snapshot([
    conversation('queue',[incoming('q',101)]),
    conversation('mine',[incoming('m',101)],'ana'),
    conversation('other',[incoming('o',101)],'bia'),
    {...conversation('closed',[incoming('c',101)],'ana'),status:'resolved'},
    conversation('sent',[{id:'s',direction:'out',state:'sent',created:101,operator_id:'ana'}],'ana')
  ],102));
  assert.deepEqual(changes.map(c=>[c.conversation,c.kind]),[['queue','queue'],['mine','mine'],['other','assigned']]);
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

test('direct phone replies stop queue wait without assigning or closing the case; a new inbound restarts it',()=>{
  const c={...conversation('phone',[incoming('first',10),{id:'phone',direction:'out',state:'sent',operator_name:'WhatsApp vinculado',operator_id:null,created:20}]),attendance_history:[{action:'Nova mensagem após encerramento: devolvido à fila',next_owner:null,created:10}]};
  assert.equal(waitingSince(c),null);assert.equal(queueWaitingSince(c),null);assert.equal(conversationWaitingSince(c),null);assert.equal(waitLabel(conversationWaitingSince(c),100),'Sem espera pendente');
  assert.equal(c.assigned_to,null);assert.equal(c.status,'open');
  const waiting=conversation('waiting',[incoming('pending',30)]);
  assert.deepEqual(prioritize([c,waiting],'queue').map(c=>c.id),['waiting','phone']);
  assert.equal(queueWaitingSince({...c,messages:[...c.messages,incoming('new',50)]}),50);
  const sameSecond={...c,messages:[incoming('first',20),c.messages[1]]};assert.equal(queueWaitingSince(sameSecond),null);
  for(const state of ['failed','uncertain','queued','simulated'])assert.equal(queueWaitingSince({...c,messages:[c.messages[0],{...c.messages[1],state}]}),10);
  assert.equal(queueWaitingSince({...c,messages:[c.messages[0],{...c.messages[1],kind:'reaction'}]}),10);
});


test('attendance filters separate assigned open cases, queue and every kind of closure',()=>{
 const assigned=conversation('assigned',[],'ana'),other=conversation('other',[],'bia'),queued=conversation('queued',[]),normal={...conversation('normal',[],'ana'),status:'resolved'},bulk={...conversation('bulk',[]),status:'resolved',attendance_history:[{action:'Atendimento encerrado em massa sem início'}]},social={...conversation('social',[]),attendance_eligible:false};
 const state={...snapshot([assigned,other,queued,normal,bulk,social]),user:{id:'ana',role:'admin'}};
 const ids=options=>filterAttendanceConversations(state,options).map(c=>c.id);
 assert.deepEqual(ids({scope:'all',status:'open'}),['assigned','other']);
 assert.deepEqual(ids({scope:'all',status:'queue'}),['queued']);
 assert.deepEqual(ids({scope:'all',status:'resolved'}),['normal','bulk']);
 assert.deepEqual(ids({scope:'all',status:'all'}),['assigned','other','queued','normal','bulk','social']);
 assert.deepEqual(ids({scope:'all',status:'all',owner:'ana'}),['assigned','normal']);
 assert.deepEqual(ids({scope:'all',status:'queue',owner:'ana'}),[]);
 assert.deepEqual(ids({scope:'mine',status:'all',owner:'bia'}),['assigned','normal']);
 assert.deepEqual(ids({scope:'queue',status:'queue'}),['queued']);
 assert.deepEqual(ids({scope:'interactions',status:'open'}),['social']);
 assert.equal(attendanceStatus({...queued,assignee_name:'Stale owner'}),'queue');
 assert.equal(attendanceStatus(bulk),'resolved');
 state.user.role='receptionist';assert.deepEqual(ids({scope:'all',status:'all',owner:'ana'}),['assigned','other','queued','normal','bulk','social']);
});
