import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopNotifications} from '../public/desktop-notifications.js';

test('mine outgoing activity never pushes, closes old notices, and customer activity enables pushes again',async()=>{
 let clock=Date.now();const rows=[],store=new Map(),incoming={id:'in',direction:'in',created:clock-20*60000};
 const mine={id:'mine',account:'a',name:'Mine',status:'open',assigned_to:'u',messages:[incoming]},state={tenant:{id:'t'},user:{id:'u',role:'agent'},accounts:[{id:'a',visual_alert_minutes:10}],conversations:[mine]};
 class Notice{static permission='granted';constructor(title,options){this.title=title;this.options=options;rows.push(this);}close(){this.closed=true;this.onclose?.();}}
 const desktop=createDesktopNotifications({getState:()=>state,openConversation(){},toast(){},NotificationClass:Notice,storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},now:()=>clock});
 await desktop.sync(state,[{conversation:'mine',name:'Mine',kind:'mine',message:incoming}]);assert.equal(rows.length,2);
 const outgoing={id:'phone',direction:'out',state:'sent',created:clock,operator_id:null};mine.messages.push(outgoing);
 await desktop.sync(state,[{conversation:'mine',name:'Mine',kind:'mine',message:outgoing}]);assert.equal(rows.length,2);assert.ok(rows.every(n=>n.closed));
 clock+=30*60000;await desktop.sync(state);assert.equal(rows.length,2);
 const queue={...mine,id:'queue',name:'Queue',assigned_to:null,messages:[incoming]},other={...mine,id:'other',name:'Other',assigned_to:'colleague',messages:[outgoing]};state.conversations.push(queue,other);await desktop.sync(state);assert.equal(rows.length,3);assert.match(rows.at(-1).title,/2 atendimento/);assert.doesNotMatch(rows.at(-1).options.body,/Mine/);
 const fresh={id:'back',direction:'in',created:clock};mine.messages.push(fresh);await desktop.sync(state,[{conversation:'mine',name:'Mine',kind:'mine',message:fresh}]);assert.match(rows.at(-1).title,/Nova mensagem/);
 clock+=11*60000;await desktop.sync(state);assert.match(rows.at(-1).title,/3 atendimento/);
});
test('desktop notices require opt-in, group overdue cases, deduplicate and open the authorized conversation',async()=>{
 let clock=Date.now(),requests=0,focused=0,opened=[],state={tenant:{id:'t'},user:{id:'u',role:'admin'},accounts:[{id:'a',visual_alert_minutes:10}],conversations:[]};
 const rows=[],store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},locks={request:async(_key,work)=>work()};
 class Notice{static permission='default';static async requestPermission(){requests++;return this.permission='granted';}constructor(title,options){this.title=title;this.options=options;rows.push(this);}close(){this.closed=true;this.onclose?.();}}
 const input={getState:()=>state,openConversation:id=>opened.push(id),toast(){},NotificationClass:Notice,storage,locks,focus:()=>focused++,now:()=>clock};
 const desktop=createDesktopNotifications(input),message={id:'old',created:clock-20*60000,direction:'in'};
 state.conversations=[{id:'c',name:'Maria',account:'a',status:'open',assigned_to:'u',assignee_name:'Ana',messages:[message]}];
 await desktop.sync(state,[]);assert.equal(rows.length,0);assert.equal(requests,0);
 await desktop.toggle();assert.equal(requests,1);assert.equal(desktop.status().enabled,true);assert.equal(rows.length,1);assert.match(rows[0].title,/precisam de atenção/);assert.match(rows[0].options.body,/Maria/);
 await desktop.sync(state,[]);assert.equal(rows.length,1);
 const peer=createDesktopNotifications(input);await peer.sync(state,[]);assert.equal(rows.length,1);
 const fresh={id:'new',direction:'in',created:clock};state.conversations[0].messages.push(fresh);
 const change={conversation:'c',name:'Maria',kind:'mine',owner:'Ana',count:1,message:fresh};await desktop.sync(state,[change]);assert.equal(rows.length,2);await peer.sync(state,[change]);assert.equal(rows.length,2);
 rows[1].onclick();assert.deepEqual(opened,['c']);assert.equal(focused,1);
 clock+=11*60000;await desktop.sync(state,[]);assert.equal(rows.length,3);assert.match(rows[2].title,/atenção/);
 await desktop.toggle();assert.equal(desktop.status().enabled,false);assert.ok(rows.every(r=>r.closed));await desktop.sync(state,[{...change,message:{...fresh,id:'newer'}}]);assert.equal(rows.length,3);
 await desktop.toggle();desktop.test();assert.match(rows.at(-1).title,/Avisos ativados/);desktop.reset();
 state={...state,user:{id:'another',role:'admin'}};assert.equal(desktop.status().enabled,false);
});
test('blocked permissions are never requested again, and reset cancels pending work',async()=>{
 let requests=0,work;const state={tenant:{id:'t'},user:{id:'u',role:'admin'},accounts:[],conversations:[]},map=new Map();
 class Notice{static permission='denied';static async requestPermission(){requests++;}constructor(){throw Error('must not display');}}
 const desktop=createDesktopNotifications({getState:()=>state,openConversation(){},toast(){},NotificationClass:Notice,storage:{getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)}});
 await desktop.toggle();assert.equal(requests,0);assert.equal(desktop.status().enabled,false);
 const unsupported=createDesktopNotifications({getState:()=>state,openConversation(){},toast(){},NotificationClass:null,storage:{getItem(){}}});await unsupported.toggle();assert.equal(unsupported.status().supported,false);
});
test('non-admin notifications are mandatory, ignore paused preferences, and check permissions every two minutes',async()=>{
 let clock=Date.now(),warnings=[],permissionRequests=0;const state={tenant:{id:'t'},user:{id:'u',role:'agent'},accounts:[{id:'a'}],conversations:[]},store=new Map([['acquarella:desktop:t:u',JSON.stringify({enabled:false})]]),rows=[];
 class Notice{static permission='default';static async requestPermission(){permissionRequests++;return this.permission='granted';}constructor(title,options){rows.push({title,options});}close(){}}
 const desktop=createDesktopNotifications({getState:()=>state,openConversation(){},toast:text=>warnings.push(text),NotificationClass:Notice,storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},now:()=>clock});
 desktop.checkPermission();assert.equal(warnings.length,1);assert.equal(permissionRequests,0);desktop.checkPermission();assert.equal(warnings.length,1);
 clock+=119999;desktop.checkPermission();assert.equal(warnings.length,1);clock++;desktop.checkPermission();assert.equal(warnings.length,2);
 assert.equal(desktop.status().required,true);await desktop.toggle();assert.equal(permissionRequests,1);assert.equal(desktop.status().enabled,true);
 await desktop.toggle();assert.equal(desktop.status().enabled,true);
 store.set('acquarella:desktop:t:u',JSON.stringify({enabled:false}));assert.equal(desktop.status().enabled,true);
 Notice.permission='denied';clock+=120000;desktop.checkPermission();assert.equal(desktop.status().needsPermission,true);assert.match(warnings.at(-1),/Libere as notificações/);
});
test('desktop delivery reports handled notices so internal duplicates can be suppressed, with fallback on failure',async()=>{
 const state={tenant:{id:'t'},user:{id:'u',role:'receptionist'},accounts:[{id:'a'}],conversations:[{id:'c',account:'a',status:'open',assigned_to:'u',messages:[]}]},store=new Map();let failing=false;
 class Notice{static permission='granted';constructor(){if(failing)throw Error('blocked by platform');}close(){}}
 const desktop=createDesktopNotifications({getState:()=>state,openConversation(){},toast(){},NotificationClass:Notice,storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)}});
 const change={conversation:'c',name:'Maria',kind:'mine',message:{id:'new'},count:1};assert.equal((await desktop.sync(state,[change])).has('c'),true);assert.equal((await desktop.sync(state,[change])).has('c'),true);
 failing=true;assert.equal((await desktop.sync(state,[{...change,message:{id:'next'}}])).has('c'),false);
 Notice.permission='denied';assert.equal((await desktop.sync(state,[change])).size,0);
});

test('attention notices persist, retain unresolved cases, and close when activity resolves the pending episode',async()=>{
 let clock=Date.now();const rows=[],store=new Map(),state={tenant:{id:'t'},user:{id:'u',role:'agent'},accounts:[{id:'a',visual_alert_minutes:10}],conversations:['c','d'].map(id=>({id,name:id,account:'a',status:'open',assigned_to:'u',messages:[{id:'old-'+id,direction:'in',created:clock-20*60000}]}))};
 class Notice{static permission='granted';constructor(title,options){this.title=title;this.options=options;rows.push(this);}close(){this.closed=true;this.onclose?.();}}
 const desktop=createDesktopNotifications({getState:()=>state,openConversation(){},toast(){},NotificationClass:Notice,storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},now:()=>clock});
 await desktop.sync(state);assert.equal(rows.length,1);assert.equal(rows[0].options.requireInteraction,true);assert.match(rows[0].title,/2 atendimento/);
 clock+=60000;await desktop.sync(state);assert.equal(rows.length,1);assert.ok(!rows[0].closed);
 state.conversations[0].messages.push({id:'reply',direction:'out',state:'sent',created:clock});await desktop.sync(state);assert.equal(rows[0].closed,true);assert.equal(rows.length,2);assert.equal(rows[1].options.silent,true);assert.match(rows[1].title,/1 atendimento/);assert.equal(rows[1].options.body.startsWith('d ·'),true);
 state.conversations[1].status='resolved';await desktop.sync(state);assert.equal(rows[1].closed,true);
 clock+=11*60000;await desktop.sync(state);assert.equal(rows.length,2,'outgoing follow-up must remain quiet even after the deadline');state.conversations[0].messages.push({id:'customer-back',direction:'in',created:clock});clock+=11*60000;await desktop.sync(state);assert.equal(rows.length,3);rows[2].close();clock+=60000;await desktop.sync(state);assert.equal(rows.length,3,'manual dismissal is respected for the same pending episode');
});
