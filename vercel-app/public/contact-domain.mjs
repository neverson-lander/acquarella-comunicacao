const invalid=message=>Object.assign(Error(message),{status:400});
export function normalizeContactPhone(value){
  if(typeof value!=='string'||value.length>40||!/^\+?[\d\s().-]+$/.test(value.trim()))throw invalid('Telefone obrigatório. Informe DDD e número.');
  let digits=value.replace(/\D/g,'');if(digits.length===10||digits.length===11)digits='55'+digits;
  if(!/^[1-9]\d{11,14}$/.test(digits))throw invalid('Telefone inválido. Informe DDD e número completo.');
  if(digits.startsWith('55')&&!/^55[1-9]\d\d{8,9}$/.test(digits))throw invalid('Telefone brasileiro inválido. Use DDD e oito ou nove dígitos.');
  return digits;
}
export function contactPhoneKey(value){
  let phone;try{phone=normalizeContactPhone(value);}catch{return '';}
  return /^55[1-9]\d9[6-9]\d{7}$/.test(phone)?phone.slice(0,4)+phone.slice(5):phone;
}
export function displayContactPhone(value){const phone=String(value||''),national=phone.startsWith('55')?phone.slice(2):phone;if(!/^\d{10,11}$/.test(national))return phone?'+'+phone:'';return `(${national.slice(0,2)}) ${national.slice(2,-4)}-${national.slice(-4)}`;}
export const csvHeaders=['Nome','Telefone','Email','Tags','Observações','Remover de campanhas'];
const headerKey=value=>String(value||'').replace(/^\uFEFF/,'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function parseContactsCsv(text){
  if(typeof text!=='string'||text.length>2000000)throw invalid('Use um CSV de até 2 MB e 1.000 contatos por importação.');
  if(text.includes('\0'))throw invalid('Arquivo CSV inválido.');
  text=text.replace(/^\uFEFF/,'');
  const first=text.split(/\r?\n/,1)[0],delimiter=(first.match(/;/g)||[]).length>(first.match(/,/g)||[]).length?';':',';
  const rows=[];let row=[],cell='',quoted=false,closed=false,line=1;
  for(let i=0;i<=text.length;i++){
    const char=text[i];
    if(quoted){if(char==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else if(char===undefined)throw invalid('CSV com aspas não fechadas.');else cell+=char;continue;}
    if(char==='"'&&cell===''&&!closed){quoted=true;continue;}
    if(char===delimiter||char==='\n'||char==='\r'||char===undefined){
      row.push(cell);cell='';closed=false;
      if(char!==delimiter){if(row.some(v=>v.trim()))rows.push({values:row,line});row=[];if(char==='\r'&&text[i+1]==='\n')i++;line++;}
    }else{if(closed&&!/\s/.test(char))throw invalid('CSV inválido após fechamento de aspas.');if(!closed)cell+=char;}
    if(rows.length>1001)throw invalid('Importe até 1.000 contatos por arquivo.');
  }
  if(rows.length<2)throw invalid('O CSV deve ter cabeçalho e pelo menos um contato.');
  const headers=rows.shift().values.map(v=>v.trim()),keys=headers.map(headerKey);
  if(new Set(keys).size!==keys.length||keys.some(v=>!v))throw invalid('Há cabeçalhos vazios ou repetidos no CSV.');
  const aliases={nome:'name',canal:'account',telefone:'phone',email:'email',tags:'tags',observacoes:'notes',removerdecampanhas:'campaignExcluded'};
  for(const key of ['nome','telefone'])if(!keys.includes(key))throw invalid('O CSV precisa das colunas Nome e Telefone. Selecione o canal na tela de importação.');
  return rows.map(({values,line})=>{
    if(values.length!==headers.length)throw invalid(`Linha ${line}: quantidade de colunas diferente do cabeçalho.`);
    const result={line,fields:{}};
    keys.forEach((key,index)=>{if(aliases[key])result[aliases[key]]=values[index].trim();else result.fields[headers[index]]=values[index].trim();});
    if('tags'in result)result.tags=result.tags.split('|').map(v=>v.trim()).filter(Boolean);
    if('campaignExcluded'in result){const v=headerKey(result.campaignExcluded);if(!['','sim','nao','true','false','1','0'].includes(v))throw invalid(`Linha ${line}: Remover de campanhas deve ser Sim ou Não.`);result.campaignExcluded=['sim','true','1'].includes(v);}
    return result;
  });
}
export function contactsCsvTemplate(fields=[]){
  const escape=value=>'"'+String(value).replaceAll('"','""')+'"';
  return '\uFEFF'+[...csvHeaders,...fields.map(f=>f.name)].map(escape).join(';')+'\r\n';
}
