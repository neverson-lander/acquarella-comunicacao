const collator=new Intl.Collator('pt-BR',{sensitivity:'base',numeric:true});
export const nameOrder=(a,b)=>collator.compare(String(a.name||'').trim(),String(b.name||'').trim());
