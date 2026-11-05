export const canQuoteMessage=message=>message?.direction==='in'&&typeof message.external==='string'&&!!message.external&&!message.deletion&&!['reaction','deletion','deleted','unsupported'].includes(message.kind);
export function quoteExcerpt(message){
  const labels={image:'Imagem',audio:'Áudio',video:'Vídeo',document:'Documento',file:'Arquivo',sticker:'Figurinha'};
  return String(message.media?.caption||message.body||message.media?.name||labels[message.kind]||'Mensagem recebida').replace(/\s+/g,' ').trim().slice(0,500);
}
