import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createContactDirectory} from '../lib/contact-directory.mjs';
import {normalizeContactPhone,contactPhoneKey,parseContactsCsv,contactsCsvTemplate} from '../public/contact-domain.mjs';

test('Excel CSV: BOM, delimiters, escaped quotes, optional email, custom columns and invalid data',()=>{
  assert.equal(normalizeContactPhone('(34) 98874-8139'),'5534988748139');
  assert.equal(contactPhoneKey('5534988748139'),contactPhoneKey('553488748139'));
  const [row]=parseContactsCsv('\uFEFFNome;Telefone;Email;Tags;Observações;Aniversário\r\n"Ana; \"\"Silva\"\"";(34) 98874-8139;;VIP|Cliente;"Linha 1\nLinha 2";2020-01-01');
  assert.equal(row.name,'Ana; "Silva"');assert.equal(row.email,'');assert.deepEqual(row.tags,['VIP','Cliente']);assert.equal(row.notes,'Linha 1\nLinha 2');assert.equal(row.fields.Aniversário,'2020-01-01');
  assert.equal(parseContactsCsv('Nome,Telefone\nAna,34988748139')[0].phone,'34988748139');
  assert.ok(contactsCsvTemplate().startsWith('\uFEFF"Nome";"Telefone";"Email"'));
  assert.throws(()=>parseContactsCsv('Nome;Telefone;E-mail;Email\nAna;123;a;b'));
  assert.throws(()=>parseContactsCsv('Nome;Telefone\n"Ana;123'));
  assert.throws(()=>normalizeContactPhone('123'));
});

test('directory with PostgreSQL: channel-scoped upsert, selected/file/old tag union, tag clearing, audit, fields, guards and atomic import',async()=>{
  const db=new PGlite();
  const query=async(sql,args=[])=>{const r=await db.query(sql,args);for(const f of r.fields||[])if(f.dataTypeID===20)for(const row of r.rows)if(row[f.name]!==null)row[f.name]=Number(row[f.name]);return {...r,rowCount:r.affectedRows??r.rows.length};};
  const pool={query,connect:async()=>({query,release(){}})},tenant=randomUUID(),otherTenant=randomUUID(),a=randomUUID(),b=randomUUID(),foreign=randomUUID();
  try{
    for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
    for(const id of [tenant,otherTenant])await query("insert into tenants(id,name,phone) values($1,'Teste','5534888888888')",[id]);
    for(const [id,t]of [[a,tenant],[b,tenant],[foreign,otherTenant]])await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,$3,'whatsapp','{}','demo')",[id,t,id===a?'Canal A':'Canal B']);
    const user={id:randomUUID(),tenant,name:'Administrador Teste',role:'admin',accounts:[]};await query("insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,'admin@test.invalid','unused','admin','[]')",[user.id,tenant,user.name]);
    const permitted=(u,c)=>c.tenant===u.tenant&&(u.role==='admin'||u.accounts.includes(c.id));
    const directory=createContactDirectory({pool,permitted}),call=(path,input,u=user)=>directory.route(u,'/api/contacts'+path,input,new URLSearchParams()),sql=(s,p)=>query(s,p).then(r=>r.rows);
    const tag=async name=>(await sql("insert into crm_catalog(tenant,kind,name) values($1,'tag',$2) returning id",[tenant,name]))[0].id;
    const oldTag=await tag('Antiga'),selectedTag=await tag('Tela'),fileTag=await tag('Arquivo');
    const input={name:'Ana',phone:'(34) 98874-8139',account:a,email:'ana@test.invalid',notes:'Manter',tags:[oldTag],campaignExcluded:true};
    const saved=await call('',input),id=saved.id;
    await assert.rejects(call('',input),e=>e.status===409);
    await call('',{...input,account:b,name:'Outro canal'});
    const csv='Nome;Telefone;Tags\r\nAna alterada;3488748139;Arquivo';
    const plan=await call('/import/preview',{csv,account:a,tags:[selectedTag]});assert.deepEqual(plan.errors,[]);assert.equal(plan.summary.updated,1);assert.equal(plan.summary.created,0);
    const commit={csv,account:a,tags:[selectedTag],hash:plan.hash,id:randomUUID()};await call('/import/commit',commit);await call('/import/commit',commit);
    let c=(await sql('select * from crm_contacts where id=$1',[id]))[0];assert.equal(c.name,'Ana alterada');assert.equal(c.email,input.email);assert.equal(c.notes,input.notes);assert.equal(c.campaign_excluded,true);
    const tagsFor=()=>sql('select tag from crm_contact_tags where contact=$1 order by tag',[id]).then(rows=>rows.map(r=>r.tag).sort());
    assert.deepEqual(await tagsFor(),[oldTag,selectedTag,fileTag].sort());
    const sameOther=(await sql('select * from crm_contacts where account=$1',[b]))[0];assert.equal(sameOther.name,'Outro canal');
    const clear={account:a,tags:[],csv:'Nome;Telefone\nAna sem tags;3488748139'},clearPreview=await call('/import/preview',clear);assert.equal(clearPreview.summary.clearTags,1);assert.equal(clearPreview.rows[0].clearTags,true);
    await call('/import/commit',{...clear,hash:clearPreview.hash,id:randomUUID()});assert.deepEqual(await tagsFor(),[]);
    const fileOnly={...clear,csv:'Nome;Telefone;Tags\nAna;3488748139;Nova|Arquivo'};const fp=await call('/import/preview',fileOnly);assert.deepEqual(fp.summary.newTags,['Nova']);await call('/import/commit',{...fileOnly,hash:fp.hash,id:randomUUID()});assert.equal((await tagsFor()).length,2);
    const screenOnly={...clear,tags:[selectedTag]},sp=await call('/import/preview',screenOnly);assert.equal(sp.summary.clearTags,0);await call('/import/commit',{...screenOnly,hash:sp.hash,id:randomUUID()});assert.equal((await tagsFor()).length,3);
    const field=await call('/fields',{name:'Aniversário',kind:'date'});await call('',{...input,id,customFields:{[field.id]:'2000-05-01'}});
    await assert.rejects(call('',{...input,id,email:'inválido'}),/E-mail/);await assert.rejects(call('',{...input,id,notes:'x'.repeat(401)}),/Observações/);await assert.rejects(call('/fields',{name:'Observacoes',kind:'text'}),/reservado/);
    const invalid=await call('/import/preview',{account:a,csv:'Nome;Telefone;Aniversário\nAna;3488748139;2020-02-30'});assert.equal(invalid.errors.length,1);
    await assert.rejects(call('/import/preview',{csv}),/Selecione/);await assert.rejects(call('/import/preview',{account:foreign,csv}),e=>e.status===403);
    const mismatch=await call('/import/preview',{account:a,csv:'Nome;Telefone;Canal\nAna;3488748139;Canal B'});assert.equal(mismatch.errors.length,1);
    const duplicate=await call('/import/preview',{account:a,csv:'Nome;Telefone\nAna;34988748139\nAna;3488748139'});assert.equal(duplicate.errors.length,1);
    const stale=await call('/import/preview',clear);await call('',{...input,id,name:'Alteração concorrente'});await assert.rejects(call('/import/commit',{...clear,hash:stale.hash,id:randomUUID()}),e=>e.status===409);
    const bad={account:a,csv:'Nome;Telefone\nNova;34999988888\nErro;123'},bp=await call('/import/preview',bad);await assert.rejects(call('/import/commit',{...bad,hash:bp.hash,id:randomUUID()}));assert.equal((await sql("select id from crm_contacts where name='Nova'")).length,0);
    const history=await call('/'+id+'/history');assert.ok(history.history.some(h=>h.before_data?.name==='Ana'&&h.after_data?.name==='Ana alterada'));assert.ok(history.history.some(h=>h.action==='Tag removida'));assert.ok(history.history.every(h=>h.actor===user.id&&h.actor_name===user.name));
    await call('/'+id+'/status',{active:false});assert.equal((await call('')).contacts.some(c=>c.id===id),false);await call('/'+id+'/status',{active:true});
    const receptionist={...user,role:'receptionist',accounts:[a]};assert.equal((await call('',undefined,receptionist)).contacts.some(c=>c.account===b),false);await assert.rejects(call('/'+sameOther.id+'/history',undefined,receptionist),e=>e.status===403);await assert.rejects(call('/import/preview',clear,receptionist),e=>e.status===403);await assert.rejects(call('',undefined,{...user,role:'agent'}),e=>e.status===403);
    await query('update accounts set enabled=false where id=$1',[a]);await assert.rejects(call('/import/preview',clear),/Ative o canal/);
  }finally{await db.close();}
});
