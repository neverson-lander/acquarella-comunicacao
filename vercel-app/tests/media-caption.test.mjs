import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {normalizeMessage} from '../../whatsapp-qr-gateway/messages.mjs';
import {qrInboundPayload} from '../lib/whatsapp-qr.mjs';
import {qrSessionId} from '../lib/qr-protocol.mjs';
import {inboundWhatsApp} from '../lib/sac.mjs';
import {messageContent} from '../public/message-content.js';

const esc=value=>String(value||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const caption='Segue meu comprovante.\nAgendamento para sexta-feira! <script>teste</script>';

test('QR image, video and wrapped document captions survive normalization, webhook adapter and rendering',async()=>{
 const account={id:randomUUID(),tenant:randomUUID(),external:'qr-account'},session=qrSessionId(account);
 for(const kind of ['image','video','document'])for(const fromMe of [false,true]){
  const item={caption,mimetype:kind==='document'?'application/pdf':kind==='video'?'video/mp4':'image/png',fileName:'comprovante.'+(kind==='document'?'pdf':kind==='video'?'mp4':'png'),fileLength:4};
  const native={[kind+'Message']:item},raw={key:{remoteJid:'5534999999999@s.whatsapp.net',id:'native-'+kind+'-'+fromMe,fromMe},pushName:'Cliente',messageTimestamp:Math.floor(Date.now()/1000),message:kind==='document'?{documentWithCaptionMessage:{message:native}}:native};
  let saved=0;
  const normalized=await normalizeMessage(raw,{session,socket:{},store:{saveMedia(){saved++;}},download:async()=>Readable.from([Buffer.from('data')])});
  assert.equal(saved,1);assert.equal(normalized.body,caption);assert.equal(normalized.media.caption,caption);
  const adapted=qrInboundPayload(account,{session,id:randomUUID(),message:normalized});
  const parsed=inboundWhatsApp(adapted.entry[0].changes[0].value)[0];
  assert.equal(parsed.body,caption);assert.equal(parsed.media.caption,caption);
  const message={id:randomUUID(),...parsed,direction:fromMe?'out':'in'},html=messageContent(message,esc);
  assert.ok(html.includes('<p class="media-caption">'+esc(caption)+'</p>'));assert.equal(html.split('Segue meu comprovante.').length-1,1);assert.ok(!html.includes('<script>'));assert.ok(html.includes('attachment-card'));
  const legacy=structuredClone(message);delete legacy.media.caption;
  assert.ok(messageContent(legacy,esc).includes('<p class="media-caption">'+esc(caption)+'</p>'));
 }
});

test('caption fallback does not repeat generated placeholders or outgoing attachment filenames',()=>{
 for(const kind of ['image','video','audio','document','sticker']){
  const label={image:'Imagem',video:'Vídeo',audio:'Áudio',document:'Documento',sticker:'Figurinha'}[kind];
  const message={id:'test',kind,body:`[${label} recebida no WhatsApp]`,media:{qrId:randomUUID(),name:kind}};
  assert.ok(!messageContent(message,esc).includes('media-caption'));
 }
 const file={id:'test',kind:'document',body:'comprovante.pdf',media:{attachmentId:randomUUID(),name:'comprovante.pdf'}};
 assert.ok(!messageContent(file,esc).includes('media-caption'));
 assert.ok(messageContent({...file,media:{...file.media,caption:'Texto explícito'}},esc).includes('<p class="media-caption">Texto explícito</p>'));
 const cloud=inboundWhatsApp({messages:[{id:'wamid',from:'5534999999999',type:'image',image:{id:'123',caption:'Legenda oficial'}}]})[0];
 const html=messageContent({id:'cloud',...cloud},esc);assert.equal(html.split('Legenda oficial').length-1,1);assert.ok(!html.includes('[Imagem]'));
});
