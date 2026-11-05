import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVault} from '../vault.mjs';
import {CashBrowser} from '../browser.mjs';

test('encrypted session vault is authenticated, tenant-bound and survives restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cashbarber-')),key=randomBytes(32);
 try{const vault=createVault(directory,key);await vault.write('session_one',{cookies:['secret-cookie']});assert.ok(!(await readFile(join(directory,'session_one.enc'))).includes('secret-cookie'));assert.deepEqual(await createVault(directory,key).read('session_one'),{cookies:['secret-cookie']});assert.equal(await vault.read('session_two'),null);await assert.rejects(createVault(directory,randomBytes(32)).read('session_one'));await vault.remove('session_one');assert.equal(await vault.read('session_one'),null);}finally{await rm(directory,{recursive:true,force:true});}
});

test('booking revalidates quote, stores intent before saving, verifies new ID and never resubmits after restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cashbarber-')),vault=createVault(directory,randomBytes(32));let saves=0;
 const date=new Date(Date.now()+86400000).toISOString().slice(0,10),quote={clientId:'1',professionalId:'2',service:'Manicure',date,start:'14:00',end:'14:50',price:0,duration:50,professionalName:'Isaura'};
 const cash=new CashBrowser(null,vault),operation=randomUUID(),tenant=randomUUID();
 cash.preview=async()=>({available:true,quote,client:{history:[{id:'10'}]},form:{getByRole:()=>({click:async()=>{assert.equal((await vault.read('booking_'+tenant+'_'+operation)).state,'pending');saves++;}}),waitFor:async()=>{}}});
 const [y,m,d]=date.split('-');cash.client=async()=>({history:[{id:'11',date:`${d}/${m}/${y} 14:00`,professional:'Isaura',service:'Manicure',status:'Agendado'}]});
 try{const result=await cash.commit(tenant,null,{quote,operation});assert.equal(result.state,'confirmed');assert.equal(result.externalId,'11');assert.equal(saves,1);const restarted=new CashBrowser(null,vault);assert.equal((await restarted.commit(tenant,null,{quote,operation})).state,'confirmed');assert.equal(saves,1);
 const altered=randomUUID();cash.preview=async()=>({available:true,quote:{...quote,price:4500},form:{getByRole:()=>({click:async()=>{}})}});assert.equal((await cash.commit(tenant,null,{quote,operation:altered})).state,'rejected');assert.equal(saves,1);
 const pending=randomUUID();await vault.write('booking_'+tenant+'_'+pending,{state:'pending',quote,knownIds:['10']});assert.equal((await cash.commit(tenant,null,{quote,operation:pending})).state,'uncertain');assert.equal((await cash.reconcile(tenant,null,{operation:pending})).externalId,'11');assert.equal(saves,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('timeout after save remains uncertain; read-only reconciliation can recover without another save',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cashbarber-')),vault=createVault(directory,randomBytes(32)),cash=new CashBrowser(null,vault);let clicks=0;
 const date=new Date(Date.now()+86400000).toISOString().slice(0,10),quote={clientId:'1',professionalId:'2',service:'Manicure',date,start:'14:00',end:'14:50',price:0,duration:50,professionalName:'Isaura'},operation=randomUUID(),tenant=randomUUID();
 cash.preview=async()=>({available:true,quote,client:{history:[]},form:{getByRole:()=>({click:async()=>{clicks++;}}),waitFor:async()=>{throw Error('timeout');}}});
 try{assert.equal((await cash.commit(tenant,null,{quote,operation})).state,'uncertain');assert.equal(clicks,1);const [y,m,d]=date.split('-');cash.client=async()=>({history:[{id:'55',date:`${d}/${m}/${y} 14:00`,professional:'Isaura',service:'Manicure',status:'Agendado'}]});assert.equal((await cash.reconcile(tenant,null,{operation})).state,'confirmed');assert.equal(clicks,1);}finally{await rm(directory,{recursive:true,force:true});}
});
