export function bookingDate(value){
 const text=String(value||''),match=text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/);
 if(match)return `${match[3]}/${match[2]}/${match[1]}`;
 return /^\d{2}\/\d{2}\/\d{4}$/.test(text)?text:'Data não informada';
}
export function bookingTextDates(value){return String(value||'').replace(/\b\d{4}-\d{2}-\d{2}\b/g,date=>bookingDate(date));}
