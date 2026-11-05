import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink,open} from 'node:fs/promises';
import {join} from 'node:path';
export function createVault(directory,key){
  if(!Buffer.isBuffer(key)||key.length!==32)throw Error('CASHBARBER_STORAGE_KEY deve conter 32 bytes em base64.');
  const path=id=>{if(!/^[a-z0-9_-]{1,160}$/i.test(id))throw Error('Registro inválido.');return join(directory,id+'.enc');};
  return {
    async read(id){try{const b=await readFile(path(id)),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from(id));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    async write(id,value){await mkdir(directory,{recursive:true,mode:0o700});const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(id));const ciphertext=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);const target=path(id),temporary=target+'.'+randomBytes(8).toString('hex')+'.tmp';await writeFile(temporary,Buffer.concat([iv,c.getAuthTag(),ciphertext]),{mode:0o600,flush:true});await rename(temporary,target);if(process.platform!=='win32'){const folder=await open(directory,'r');try{await folder.sync();}finally{await folder.close();}}},
    async remove(id){await unlink(path(id)).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  };
}
