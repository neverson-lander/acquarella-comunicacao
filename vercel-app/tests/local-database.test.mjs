import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLocalPool} from '../lib/local-database.mjs';

test('local database persists independently, migrates once and serializes concurrent transactions',async()=>{
  const base=resolve(fileURLToPath(new URL('../../tmp/',import.meta.url)));await mkdir(base,{recursive:true});
  const directory=await mkdtemp(resolve(base,'qr-local-db-test-'));let pool;
  try{
    pool=await createLocalPool(directory);
    await pool.query('create table local_test_counter(id integer primary key,n bigint)');
    await pool.query('insert into local_test_counter values(1,0)');
    async function increment(){const client=await pool.connect();try{await client.query('begin');const result=await client.query('select n from local_test_counter where id=1');await client.query('update local_test_counter set n=$1',[result.rows[0].n+1]);await client.query('commit');}finally{client.release();}}
    await Promise.all([increment(),increment(),increment()]);
    assert.equal((await pool.query('select n from local_test_counter')).rows[0].n,3);
    const client=await pool.connect();await client.query('begin');await client.query('update local_test_counter set n=99');await client.query('rollback');client.release();
    const migrations=(await pool.query('select count(*) as count from local_migrations')).rows[0].count;
    await pool.end();pool=await createLocalPool(directory);
    assert.equal((await pool.query('select n from local_test_counter')).rows[0].n,3);
    assert.equal((await pool.query('select count(*) as count from local_migrations')).rows[0].count,migrations);
    assert.equal((await pool.query("select relrowsecurity from pg_class where relname='messages'")).rows[0].relrowsecurity,true);
    assert.equal((await pool.query('select count(*) as count from users')).rows[0].count,0);
  }finally{
    await pool?.end();
    assert.ok(resolve(directory).startsWith(base+sep)&&directory.split(sep).at(-1).startsWith('qr-local-db-test-'));
    await rm(directory,{recursive:true,force:true});
  }
});
