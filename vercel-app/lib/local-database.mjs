// Development-only PostgreSQL-compatible storage. This module is loaded only
// by scripts/local-server.mjs, never by the Vercel handler.
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir,mkdir} from 'node:fs/promises';

export async function createLocalPool(directory) {
  await mkdir(directory,{recursive:true});
  const db=new PGlite(directory);
  await db.exec('create table if not exists local_migrations(id text primary key)');
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort()){
    if((await db.query('select id from local_migrations where id=$1',[name])).rows.length)continue;
    // PGlite provides gen_random_uuid natively; it does not load pgcrypto.
    const sql=(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;','');
    await db.exec('begin');
    try{await db.exec(sql);await db.query('insert into local_migrations values($1)',[name]);await db.exec('commit');}
    catch(error){await db.exec('rollback');await db.close();throw error;}
  }
  let pending=Promise.resolve();
  async function lock(){const previous=pending;let unlock;pending=new Promise(resolve=>{unlock=resolve;});await previous;return unlock;}
  async function query(sql,args=[]){
    const result=await db.query(sql,args);
    for(const field of result.fields||[])if(field.dataTypeID===20)for(const row of result.rows){
      if(row[field.name]===null)continue;
      const value=Number(row[field.name]);if(!Number.isSafeInteger(value))throw Error('Inteiro fora do intervalo seguro.');row[field.name]=value;
    }
    return {...result,rowCount:result.affectedRows??result.rows.length};
  }
  return {
    async query(sql,args){const unlock=await lock();try{return await query(sql,args);}finally{unlock();}},
    async connect(){const unlock=await lock();let released=false;return {query:(...args)=>{if(released)throw Error('Conexão já liberada.');return query(...args);},release(){if(!released){released=true;unlock();}}};},
    async end(){const unlock=await lock();try{await db.close();}finally{unlock();}}
  };
}
