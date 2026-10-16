import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultServiceHours,normalizeServiceHours,withinServiceHours,normalizeForwardingSettings,forwardingPeriodAllows} from '../public/service-hours-policy.mjs';
import {forwardingAllowed} from '../lib/sac.mjs';
const stamp=value=>Date.parse(value);

test('weekly grade uses the configured timezone, end-exclusive intervals, lunch breaks and closed days',()=>{
  const hours=defaultServiceHours();hours.enabled=true;hours.days[1]=[{start:'09:00',end:'12:00'},{start:'13:00',end:'18:00'}];
  const check=time=>withinServiceHours(hours,stamp('2026-10-19T'+time+'-03:00'));
  assert.equal(check('08:59:59'),false);assert.equal(check('09:00:00'),true);assert.equal(check('11:59:59'),true);assert.equal(check('12:00:00'),false);assert.equal(check('13:00:00'),true);assert.equal(check('18:00:00'),false);
  assert.equal(withinServiceHours(hours,stamp('2026-10-18T12:00:00-03:00')),false);
  assert.equal(withinServiceHours({...hours,timezone:'America/Manaus'},stamp('2026-10-19T12:00:00Z')),false);
});

test('overnight shifts cover the next day and the Saturday/Sunday week boundary',()=>{
  const hours={enabled:true,timezone:'America/Sao_Paulo',days:Array.from({length:7},()=>[])};hours.days[6]=[{start:'22:00',end:'02:00'}];normalizeServiceHours(hours);
  for(const [time,expected]of [['2026-10-17T21:59:00-03:00',false],['2026-10-17T22:00:00-03:00',true],['2026-10-18T01:59:59-03:00',true],['2026-10-18T02:00:00-03:00',false]])assert.equal(withinServiceHours(hours,stamp(time)),expected);
  hours.days[0]=[{start:'01:00',end:'03:00'}];assert.throws(()=>normalizeServiceHours(hours),/sobrepostos/);
});

test('invalid hours and destination settings are rejected; full-day intervals and DST zones work',()=>{
  const hours=defaultServiceHours();hours.enabled=true;
  for(const value of [{...hours,timezone:'Invalid/Timezone'},{...hours,days:[]},{...hours,days:Array.from({length:7},()=>[])},{...hours,days:hours.days.map((s,i)=>i===1?[{start:'25:00',end:'18:00'}]:s)},{...hours,days:hours.days.map((s,i)=>i===1?[{start:'09:00',end:'09:00'}]:s)}])assert.throws(()=>normalizeServiceHours(value));
  const full={enabled:true,timezone:'America/New_York',days:Array.from({length:7},()=>[{start:'00:00',end:'24:00'}])};normalizeServiceHours(full);assert.equal(withinServiceHours(full,stamp('2026-11-01T06:30:00Z')),true);
  assert.throws(()=>normalizeForwardingSettings({forwardingPeriod:'outside'}),/Ative a grade/);
  assert.throws(()=>normalizeForwardingSettings({forwardingPhone:'javascript:alert(1)'}));
  assert.equal(normalizeForwardingSettings({forwardingPhone:'+55 (34) 99999-9999'}).phone,'5534999999999');
});

test('inside/outside forwarding is independent per channel, retains legacy behavior and supports the WhatsApp sender itself',()=>{
  const hours=defaultServiceHours();hours.enabled=true;
  const account={id:'qr',tenant:'tenant',channel:'whatsapp',mode:'live',forwarding_enabled:true,bridge:null,forwarding_phone:'5534999999999',service_hours:hours,forwarding_period:'outside'};
  const inside=stamp('2026-10-19T10:00:00-03:00'),outside=stamp('2026-10-19T22:00:00-03:00');
  assert.equal(forwardingAllowed(account,account,'5534888888888','5534777777777',inside),false);
  assert.equal(forwardingAllowed(account,account,'5534888888888','5534777777777',outside),true);
  assert.equal(forwardingAllowed(account,account,'5534999999999','5534777777777',outside),false);
  assert.equal(forwardingAllowed(account,{...account,tenant:'other'},'5534888888888','5534777777777',outside),false);
  assert.equal(forwardingAllowed({...account,forwarding_period:'inside'},account,'5534888888888','5534777777777',inside),true);
  assert.equal(forwardingPeriodAllows({...account,service_hours:{...hours,enabled:false}},outside),false);
  assert.equal(forwardingPeriodAllows({},outside),true);
  assert.equal(forwardingPeriodAllows(account,NaN),false);
  assert.equal(forwardingAllowed({...account,forwarding_phone:''},account,'5534888888888','5534777777777',outside),false);
});
