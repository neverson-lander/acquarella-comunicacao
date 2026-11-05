import test from 'node:test';import assert from 'node:assert/strict';import {selectedTouch} from '../public/crm-domain.mjs';
test('non-service unknown touches cannot hide ads; genuine first contact, manual corrections and frozen sale attribution remain',()=>{
 const social={id:'s',source:'unknown',evidence:'webhook',created:1,ignored_for_attribution:true},paid={id:'p',source:'paid',ad_id:'123',evidence:'webhook',created:2};
 assert.equal(selectedTouch({touches:[social,paid]}).ad_id,'123');assert.equal(selectedTouch({touches:[{...social,ignored_for_attribution:false},paid]}).source,'unknown');
 const correction={id:'m',source:'organic',evidence:'manual',referral:{correct_first:true},created:3};assert.equal(selectedTouch({touches:[social,paid,correction]}).source,'organic');
 const frozen={source:'paid',ad_id:'old'};assert.deepEqual(selectedTouch({touches:[social,paid],conversions:[{kind:'sale',occurred:4,attribution:{last_paid:frozen}}]},'last_paid'),frozen);
});
