export function cashbarberClientSearch(channel,phone,fallback=''){
 if(channel!=='whatsapp')return fallback;
 const value=String(phone||'').trim();
 if(!value)return fallback;
 if(!/^[+\d\s().-]+$/.test(value))return fallback;
 let digits=value.replace(/\D/g,'');
 if(/^55\d{10,11}$/.test(digits))digits=digits.slice(2);
 if(/^[1-9]\d[6-9]\d{7}$/.test(digits))digits=digits.slice(0,2)+'9'+digits.slice(2);
 if(!/^\d{10,11}$/.test(digits))return value;
 return `(${digits.slice(0,2)}) ${digits.slice(2,-4)}-${digits.slice(-4)}`;
}
