// Schema changes only: this runner never changes Meta subscriptions or imports
// obsolete local data. Existing app_migrations entries survive a database restore.
import {readFile,readdir} from 'node:fs/promises';
import {pool} from '../lib/database.mjs';
if(process.env.DEPLOYMENT_MODE!=='standalone')throw Error('Implantação independente não selecionada.');
const client=await pool.connect();
try{
  await client.query('begin');
  await client.query('select pg_advisory_xact_lock(94728101)');
  const existing=await client.query("select to_regclass('public.app_migrations') as migrations,to_regclass('public.tenants') as tenants");
  if(!existing.rows[0].migrations&&existing.rows[0].tenants)throw Error('Banco existente sem histórico de migrações; revisão necessária.');
  await client.query('create table if not exists app_migrations(id text primary key,applied_at timestamptz not null default now())');
  await client.query('alter table app_migrations enable row level security');
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(v=>v.endsWith('.sql')).sort()){
    const id=name.slice(0,-4);
    if((await client.query('select id from app_migrations where id=$1',[id])).rowCount)continue;
    await client.query(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    await client.query('insert into app_migrations(id) values($1)',[id]);
    console.log('Migração aplicada:',id);
  }
  await client.query('commit');
}catch(error){await client.query('rollback');throw error;}
finally{client.release();await pool.end();}
