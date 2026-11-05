export const channelNames={whatsapp:'WhatsApp',instagram:'Instagram',messenger:'Messenger'};
const paths={
  whatsapp:'<path fill="white" d="M12 2a9.8 9.8 0 0 0-8.5 14.7L2 22l5.5-1.4A10 10 0 1 0 12 2Zm0 1.8a8.2 8.2 0 1 1-4.2 15.2l-.3-.2-3 .8.8-2.9-.2-.4A8.2 8.2 0 0 1 12 3.8Z"/><path fill="white" d="M8.5 7.2c-.3 0-.6.1-.8.4-.5.5-.8 1.2-.8 2 0 1.5 1 3.3 2.8 5 1.8 1.7 3.4 2.3 4.6 2.3 1 0 2.1-.6 2.4-1.4.1-.3.2-.9.1-1.1-.1-.2-.3-.3-.6-.4l-1.6-.8c-.3-.1-.5-.1-.7.2l-.7.9c-.2.2-.3.3-.6.2a6.9 6.9 0 0 1-3.4-3c-.1-.3 0-.4.2-.6l.5-.6c.1-.2.2-.4.1-.6L9.2 7.6c-.1-.3-.3-.4-.7-.4Z"/>',
  instagram:'<rect x="4" y="4" width="16" height="16" rx="5" fill="none" stroke="white" stroke-width="1.8"/><circle cx="12" cy="12" r="3.8" fill="none" stroke="white" stroke-width="1.8"/><circle cx="17.2" cy="6.9" r="1.1" fill="white"/>',
  messenger:'<path fill="white" d="M12 2.8c-5.5 0-9.8 4-9.8 9.2 0 2.8 1.3 5.4 3.5 7v3l2.8-1.6c1.1.4 2.3.6 3.5.6 5.5 0 9.8-4 9.8-9.1S17.5 2.8 12 2.8Z"/><path fill="#087cf0" d="m6.2 14.5 5.1-5.4 3 2.8 3.5-2.2-5 5.4-3-2.8-3.6 2.2Z"/>'
};
export function channelIcon(channel){
  const known=Object.hasOwn(channelNames,channel),type=known?channel:'unknown';
  return `<span class="channel-logo channel-logo-${type}" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${paths[type]||'<path d="M4 4h16v12H9l-5 4V4Z" fill="none" stroke="white" stroke-width="1.8"/>'}</svg></span>`;
}
