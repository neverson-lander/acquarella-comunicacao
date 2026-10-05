export function metaMediaUrl(value){
  if(typeof value!=='string'||value.length>4000)return '';
  try{
    const url=new URL(value),host=url.hostname.toLowerCase();
    return url.protocol==='https:'&&!url.username&&!url.password&&['fbcdn.net','cdninstagram.com','facebook.com','instagram.com','fb.me','fb.watch'].some(domain=>host===domain||host.endsWith('.'+domain))?url.href:'';
  }catch{return '';}
}
