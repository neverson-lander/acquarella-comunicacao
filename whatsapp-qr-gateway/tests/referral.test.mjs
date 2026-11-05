import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMessage} from '../messages.mjs';
import {extractReferral} from '../referral.mjs';
test('Instagram click-to-WhatsApp ad metadata survives incoming QR normalization without binary or opaque context fields',async()=>{
 const ad={sourceType:'ad',sourceId:'120253089514020134',sourceApp:'instagram',sourceUrl:'https://www.instagram.com/p/example/',title:'Day Use',body:'Oferta '.repeat(500),ctwaClid:'click-id',thumbnail:'DO_NOT_FORWARD_BINARY',greetingMessageBody:'DO_NOT_FORWARD_GREETING'};
 const raw={key:{id:'ad-message',remoteJid:'123@lid',remoteJidAlt:'553499129824@s.whatsapp.net',fromMe:false},messageTimestamp:Math.floor(Date.now()/1000),message:{ephemeralMessage:{message:{extendedTextMessage:{text:'Olá',contextInfo:{externalAdReply:ad,ctwaPayload:'DO_NOT_FORWARD_OPAQUE'}}}}}};
 const message=await normalizeMessage(raw,{socket:{},store:{}});assert.equal(message.referral.ad_id,ad.sourceId);assert.equal(message.referral.source_app,'instagram');assert.equal(message.referral.ctwa_clid,'click-id');assert.equal(message.referral.body.length,2000);assert.ok(!JSON.stringify(message).includes('DO_NOT_FORWARD'));
 assert.equal((await normalizeMessage({...raw,key:{...raw.key,fromMe:true}},{socket:{},store:{}})).referral,undefined);
 assert.equal(extractReferral({conversation:'Vim de um anúncio no Instagram'}),null);
 assert.equal(extractReferral({extendedTextMessage:{contextInfo:{conversionSource:'FB_Ads',conversionData:'opaque'}}}),null);
});
