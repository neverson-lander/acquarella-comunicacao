import {DatabaseSync} from 'node:sqlite';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';

// One persistent process owns this SQLite file. All session keys, message bodies
// and media are encrypted; the encryption key belongs in the service environment.
export class Store {
  constructor(path,key,{replacer,reviver}={}) {
    this.key=Buffer.from(key||'','base64');if(this.key.length!==32)throw Error('QR_STORAGE_KEY deve conter 32 bytes em base64.');
    this.replacer=replacer;this.reviver=reviver;
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`pragma journal_mode=WAL; pragma busy_timeout=5000;
      create table if not exists sessions(id text primary key,enabled integer not null default 1);
      create table if not exists secrets(session text,key text,value text not null,primary key(session,key));
      create table if not exists inbox(session text,id text,body text not null,event text,done integer not null default 0,created integer not null,attempts integer not null default 0,next integer not null default 0,primary key(session,id));
      create table if not exists sends(session text,id text,external text not null,body text not null,state text not null,created integer not null,primary key(session,id));
      create table if not exists media(session text,id text,body text not null,mime text not null,created integer not null,primary key(session,id));`);
    this.db.exec("update sends set state='uncertain' where state='sending'");
  }
  seal(value) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    const body=Buffer.concat([cipher.update(JSON.stringify(value,this.replacer)),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');
  }
  open(value) {
    const b=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));cipher.setAuthTag(b.subarray(12,28));
    return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString(),this.reviver);
  }
  get(session,key) {const row=this.db.prepare('select value from secrets where session=? and key=?').get(session,key);return row?this.open(row.value):undefined;}
  set(session,key,value) {if(value==null)this.db.prepare('delete from secrets where session=? and key=?').run(session,key);else this.db.prepare('insert into secrets values(?,?,?) on conflict(session,key) do update set value=excluded.value').run(session,key,this.seal(value));}
  enable(session) {this.db.prepare('insert into sessions values(?,1) on conflict(id) do update set enabled=1').run(session);}
  disable(session) {this.db.prepare('update sessions set enabled=0 where id=?').run(session);this.db.prepare('delete from secrets where session=?').run(session);}
  active() {return this.db.prepare('select id from sessions where enabled=1').all().map(r=>r.id);}
  accept(session,message) {this.db.prepare('insert or ignore into inbox(session,id,body,created) values(?,?,?,?)').run(session,message.key.id,this.seal(message),Date.now());}
  pending() {return this.db.prepare('select * from inbox where done=0 and next<=? order by created limit 30').all(Date.now());}
  event(session,id,event) {this.db.prepare('update inbox set event=? where session=? and id=?').run(this.seal(event),session,id);}
  done(session,id) {this.db.prepare('update inbox set done=1 where session=? and id=?').run(session,id);}
  retry(row) {this.db.prepare('update inbox set attempts=attempts+1,next=? where session=? and id=?').run(Date.now()+Math.min(300000,2000*2**Math.min(row.attempts,7)),row.session,row.id);}
  sent(session,id) {return this.db.prepare('select * from sends where session=? and id=?').get(session,id);}
  wasSent(session,external) {return !!this.db.prepare('select id from sends where session=? and external=?').get(session,external);}
  recordSend(session,id,external,payload) {this.db.prepare("insert into sends values(?,?,?,?,'sending',?)").run(session,id,external,this.seal(payload),Date.now());}
  sendState(session,id,state) {this.db.prepare('update sends set state=? where session=? and id=?').run(state,session,id);}
  saveMedia(session,id,bytes,mime) {this.db.prepare('insert or replace into media values(?,?,?,?,?)').run(session,id,this.seal(bytes.toString('base64')),mime,Date.now());}
  media(session,id) {const row=this.db.prepare('select * from media where session=? and id=?').get(session,id);return row?{bytes:Buffer.from(this.open(row.body),'base64'),mime:row.mime}:null;}
  cleanup(days=30) {
    const before=Date.now()-days*86400000;
    this.db.prepare("delete from secrets where key like 'message:%' and (exists(select 1 from inbox where inbox.session=secrets.session and 'message:'||inbox.id=secrets.key and done=1 and created<?) or exists(select 1 from sends where sends.session=secrets.session and 'message:'||sends.external=secrets.key and created<?))").run(before,before);
    for(const table of ['media','sends'])this.db.prepare(`delete from ${table} where created<?`).run(before);
    this.db.prepare('delete from inbox where done=1 and created<?').run(before);
  }
  close() {this.db.close();}
}
