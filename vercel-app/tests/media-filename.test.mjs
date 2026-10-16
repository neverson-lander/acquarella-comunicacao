import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaFilename,mediaDisposition} from '../lib/media-filename.mjs';
test('downloads without names or extensions receive a suffix matching the actual content type',()=>{
 for(const [mime,name] of [['image/jpeg','Imagem.jpg'],['image/png','Imagem.png'],['audio/mp4','Imagem.m4a'],['video/mp4','Imagem.mp4'],['application/pdf','Imagem.pdf'],['application/vnd.openxmlformats-officedocument.wordprocessingml.document','Imagem.docx']])assert.equal(mediaFilename('Imagem',mime),name);
 assert.equal(mediaFilename('','application/pdf'),'anexo.pdf');assert.equal(mediaFilename('Áudio','audio/ogg'),'Áudio.ogg');
});
test('safe original names survive while incorrect extensions and generic fallback names are repaired',()=>{
 assert.equal(mediaFilename('foto.jpeg','image/jpeg'),'foto.jpeg');assert.equal(mediaFilename('orçamento.pdf','application/pdf'),'orçamento.pdf');assert.equal(mediaFilename('imagem.pdf','image/png'),'imagem.png');assert.equal(mediaFilename('arquivo.docx','application/octet-stream'),'arquivo.docx');assert.equal(mediaFilename('arquivo','application/octet-stream'),'arquivo.bin');
 assert.ok(!mediaFilename('../bad\r\nname.exe','application/pdf').includes('\r'));assert.ok(!mediaFilename('../bad\r\nname.exe','application/pdf').includes('/'));
});
test('both the ASCII fallback and UTF-8 download names carry their extension; PDFs can preview',()=>{
 const header=mediaDisposition('Áudio','audio/ogg',{download:true});assert.match(header,/filename="Audio\.ogg"/);assert.match(header,/filename\*=UTF-8''%C3%81udio\.ogg/);
 assert.match(mediaDisposition('Arquivo','application/pdf',{document:true,preview:true}),/^inline; filename="Arquivo.pdf"/);
});
