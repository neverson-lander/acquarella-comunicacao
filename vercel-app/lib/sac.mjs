import { sameWhatsAppPhone } from './whatsapp-phone.mjs';

export function signedReply(operator, body) {
  const name = String(operator || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new Error('Operador não identificado.');
  const text = `${name}:\n${body}`;
  if (text.length > 2000) throw new Error('A resposta com a assinatura deve ter até 2000 caracteres.');
  return text;
}

export function inboundWhatsApp(value) {
  return (value.messages || []).filter(m => m.id && m.from).map(m => {
    const contact = (value.contacts || []).find(c => c.wa_id === m.from);
    const captions = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', document: 'Documento', sticker: 'Figurinha', location: 'Localização', contacts: 'Contato' };
    return {
      customer: String(m.from), external: String(m.id), context: m.context?.id, referral: m.referral,
      name: typeof contact?.profile?.name === 'string' ? contact.profile.name.slice(0, 200) : '',
      body: m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title ||
        (m[m.type]?.caption ? `[${captions[m.type] || 'Anexo'}] ${m[m.type].caption}` : `[${captions[m.type] || 'Mensagem não textual'} recebida no WhatsApp]`),
      kind:m.type||'text',
      media:['image','audio','sticker'].includes(m.type)&&/^\d+$/.test(m[m.type]?.id||'')?{id:String(m[m.type].id),mime_type:String(m[m.type].mime_type||'').slice(0,100),caption:String(m[m.type].caption||'').slice(0,2000),voice:!!m[m.type].voice}:null,
      reaction:m.type==='reaction'&&typeof m.reaction?.message_id==='string'?{target:m.reaction.message_id.slice(0,500),emoji:typeof m.reaction.emoji==='string'?m.reaction.emoji.slice(0,32):''}:null,
      timestamp: (Number(m.timestamp) || Math.floor(Date.now() / 1000)) * 1000,
    };
  });
}

export function forwardingAllowed(origin, bridge, customer, teamPhone) {
  return !!(origin.forwarding_enabled && origin.bridge === bridge?.id && bridge?.channel === 'whatsapp' &&
    origin.tenant === bridge.tenant && bridge.mode === 'live' &&
    !(origin.channel === 'whatsapp' && sameWhatsAppPhone(customer, teamPhone)));
}

export async function customerProfile(account, secrets, customer, fetcher = fetch) {
  if (account.mode !== 'live' || account.channel === 'whatsapp') return {};
  const instagram = account.channel === 'instagram';
  const fields = instagram ? 'name,username' : 'first_name,last_name';
  try {
    const response = await fetcher(`https://${instagram ? 'graph.instagram.com' : 'graph.facebook.com'}/${secrets.version || 'v26.0'}/${encodeURIComponent(customer)}?fields=${fields}`, {
      headers: { Authorization: `Bearer ${secrets.token}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return {};
    const data = await response.json();
    const name = instagram ? data.name : [data.first_name, data.last_name].filter(Boolean).join(' ');
    return { name: typeof name === 'string' ? name.trim().slice(0, 200) : '', username: typeof data.username === 'string' ? data.username.slice(0, 200) : '' };
  } catch { return {}; }
}
