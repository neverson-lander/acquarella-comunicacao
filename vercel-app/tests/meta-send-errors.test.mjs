import test from 'node:test';
import assert from 'node:assert/strict';
import {metaSendError,deliveryErrorMessage} from '../public/meta-send-errors.mjs';
test('test-recipient rejection has an actionable diagnosis separate from the service window',()=>{
  const message=metaSendError('whatsapp',400,131030);
  assert.match(message,/131030/);assert.match(message,/não autorizado/);assert.match(message,/adicione e confirme/);
  assert.ok(!message.includes('24 horas'));
  assert.equal(deliveryErrorMessage(message),message);
  assert.equal(deliveryErrorMessage('Meta recusou o envio (HTTP 400, código 131030).'),message);
});
test('other errors retain their original safe description',()=>{
  assert.equal(metaSendError('whatsapp',401,190),'Meta recusou o envio (HTTP 401, código 190).');
  assert.equal(metaSendError('messenger',400,131030),'Meta recusou o envio (HTTP 400, código 131030).');
  assert.equal(deliveryErrorMessage('Janela de 24 horas encerrada.'),'Janela de 24 horas encerrada.');
  assert.equal(deliveryErrorMessage('Erro 1310300'),'Erro 1310300');
});
