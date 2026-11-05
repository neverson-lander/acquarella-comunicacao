import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
test('the central accepts eight-character passwords for setup, users, changes and new companies',async()=>{
 const db=new PGlite();const query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
 try{
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  globalThis.__acquarellaPool={query,connect:async()=>({query,release(){}})};process.env.APP_ENCRYPTION_KEY=randomBytes(32).toString('base64');const {default:app}=await import('../api/index.mjs');
  let cookie='';const request=(path,input)=>app.fetch(new Request('https://test.invalid/api/'+path,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(input)}));
  const setup={company:'Teste',name:'Administrador',email:'admin@test.invalid'};
  assert.equal((await request('setup',{...setup,password:'1234567'})).status,400);
  assert.equal((await query('select * from users')).rows.length,0);
  assert.equal((await request('setup',{...setup,password:'Abcd1234'})).status,201);
  const login=await request('login',{email:setup.email,password:'Abcd1234'});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
  const user={name:'Atendente',email:'agent@test.invalid',role:'agent',accounts:[]};
  assert.equal((await request('users',{...user,password:'1234567'})).status,400);
  assert.equal((await request('users',{...user,password:'12345678'})).status,200);
  const uid=(await query('select id from users where email=$1',[user.email])).rows[0].id;
  assert.equal((await request('users',{...user,id:uid,password:'1234567'})).status,400);
  assert.equal((await request('users',{...user,id:uid,password:'Nova1234'})).status,200);
  assert.equal((await request('users',{...user,id:uid,password:'x'.repeat(201)})).status,400);
  assert.equal((await request('login',{email:user.email,password:'Nova1234'})).status,200);
  assert.equal((await request('tenants',{name:'Nova empresa',phone:'5534999999999',adminName:'Novo administrador',email:'new@test.invalid',password:'Abcd1234'})).status,201);
 }finally{delete globalThis.__acquarellaPool;await db.close();}
});
