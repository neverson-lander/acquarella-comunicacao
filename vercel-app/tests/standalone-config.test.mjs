import test from 'node:test';
import assert from 'node:assert/strict';
import {qrConfiguration} from '../lib/whatsapp-qr.mjs';
globalThis.__acquarellaPool={};
const {databaseOptions}=await import('../lib/database.mjs');

test('standalone HTTP transport is limited to the unpublished Docker gateway',()=>{
  const env={NODE_ENV:'production',WHATSAPP_QR_SECRET:'s'.repeat(40),WHATSAPP_QR_URL:'http://whatsapp-qr:3100'};
  assert.throws(()=>qrConfiguration(env));
  assert.equal(qrConfiguration({...env,DEPLOYMENT_MODE:'standalone'}).url,'http://whatsapp-qr:3100');
  for(const url of ['http://example.com:3100','http://whatsapp-qr:3101','http://user:pass@whatsapp-qr:3100','http://whatsapp-qr:3100/path'])assert.throws(()=>qrConfiguration({...env,DEPLOYMENT_MODE:'standalone',WHATSAPP_QR_URL:url}));
});

test('remote PostgreSQL keeps certificate verification even in standalone mode',()=>{
  const keys=['DEPLOYMENT_MODE','DATABASE_URL','POSTGRES_CA'];const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
    delete process.env.POSTGRES_CA;process.env.DATABASE_URL='postgres://test:test@postgres:5432/acquarella';
    delete process.env.DEPLOYMENT_MODE;assert.equal(databaseOptions().ssl.rejectUnauthorized,true);
    process.env.DEPLOYMENT_MODE='standalone';assert.equal(databaseOptions().ssl,false);
    process.env.DATABASE_URL='postgres://test:test@db.example.com:5432/acquarella?sslmode=disable';assert.equal(databaseOptions().ssl.rejectUnauthorized,true);
    process.env.DATABASE_URL='postgres://test:test@postgres:5433/acquarella';assert.equal(databaseOptions().ssl.rejectUnauthorized,true);
  }finally{for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
});
