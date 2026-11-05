import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMessage} from '../messages.mjs';
const raw=message=>({key:{id:'test-template',remoteJid:'5511999999999@s.whatsapp.net'},messageTimestamp:1700000000,message});
const options={session:'tenant_account',socket:{},store:{saveMedia(){}},download:async()=>{throw Error('unexpected download');}};
test('hydrated templates retain title, content, footer and readable button labels',async()=>{
 const result=await normalizeMessage(raw({templateMessage:{hydratedTemplate:{hydratedTitleText:'Título',hydratedContentText:'Conteúdo',hydratedFooterText:'Rodapé',hydratedButtons:[{urlButton:{displayText:'Ver',url:'https://example.com/'}},{quickReplyButton:{displayText:'Aceitar',id:'opaque-secret'}},{urlButton:{displayText:'Inválido',url:'javascript:alert(1)'}}]}}}),options);
 assert.equal(result.kind,'text');assert.equal(result.body,'Título\n\nConteúdo\n\nRodapé\n\nVer: https://example.com/\n\nAceitar\n\nInválido');
 assert.ok(!result.body.includes('opaque-secret'));
});
test('native flow preserves body and parses only safe known button fields',async()=>{
 const result=await normalizeMessage(raw({templateMessage:{interactiveMessageTemplate:{header:{title:'Aviso'},body:{text:'Mensagem recebida'},nativeFlowMessage:{messageParamsJson:'private metadata',buttons:[{buttonParamsJson:JSON.stringify({display_text:'Abrir',url:'https://example.com',id:'private'})},{buttonParamsJson:'malformed'}]}}}}),options);
 assert.equal(result.body,'Aviso\n\nMensagem recebida\n\nAbrir: https://example.com/');
});
test('template media is downloaded using its media envelope without losing text',async()=>{
 let saved=0;const image={mimetype:'image/jpeg',fileLength:3};
 const result=await normalizeMessage(raw({templateMessage:{interactiveMessageTemplate:{header:{imageMessage:image},body:{text:'Texto do modelo'}}}}),{...options,download:async value=>{assert.deepEqual(value.message,{imageMessage:image});return [Buffer.from('img')];},store:{saveMedia(){saved++;}}});
 assert.equal(result.body,'Texto do modelo');assert.equal(result.kind,'image');assert.equal(result.media.size,3);assert.equal(saved,1);
});
test('historical text can be recovered even when template attachment is unavailable',async()=>{
 const result=await normalizeMessage(raw({templateMessage:{interactiveMessageTemplate:{header:{imageMessage:{}},body:{text:'Texto recuperado'}}}}),{...options,skipMedia:true});
 assert.match(result.body,/^Texto recuperado \[Anexo indisponível/);assert.equal(result.media,null);
});
test('placeholder explains missing vendor content and nested view once is never downloaded',async()=>{
 const missing=await normalizeMessage(raw({placeholderMessage:{type:'MESSAGE_UNAVAILABLE'}}),options);
 assert.equal(missing.kind,'unsupported');assert.match(missing.body,/não disponibilizou/);
 const once=await normalizeMessage(raw({ephemeralMessage:{message:{viewOnceMessageV2Extension:{message:{imageMessage:{}}}}}}),options);
 assert.equal(once.media,null);assert.match(once.body,/visualização única/);
});
