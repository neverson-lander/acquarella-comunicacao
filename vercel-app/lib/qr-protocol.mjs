import {createHmac,timingSafeEqual} from 'node:crypto';

export function qrSignature(secret,method,path,timestamp,body='') {
  return createHmac('sha256',secret).update(`${method}\n${path}\n${timestamp}\n${body}`).digest('hex');
}
export function qrHeaders(secret,method,path,body='',now=Date.now()) {
  const timestamp=String(now);
  return {'x-qr-time':timestamp,'x-qr-signature':qrSignature(secret,method,path,timestamp,body),'content-type':'application/json'};
}
export function validQrSignature(secret,method,path,headers,body='',now=Date.now()) {
  if(typeof secret!=='string'||secret.length<32)return false;
  const timestamp=headers.get('x-qr-time')||'',signature=headers.get('x-qr-signature')||'';
  if(!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>60000||! /^[a-f0-9]{64}$/.test(signature))return false;
  return timingSafeEqual(Buffer.from(signature),Buffer.from(qrSignature(secret,method,path,timestamp,body)));
}
export const isQrAccount=(account,open=JSON.parse)=>account?.channel==='whatsapp'&&open(account.secret).transport==='qr';
export const requiresServiceWindow=(account,open=JSON.parse)=>!isQrAccount(account,open);
export function qrSessionId(account) {
  if(!/^[a-f0-9-]{36}$/i.test(account?.id)||!/^[a-f0-9-]{36}$/i.test(account?.tenant))throw Error('Canal QR inválido.');
  return `${account.tenant}_${account.id}`;
}
