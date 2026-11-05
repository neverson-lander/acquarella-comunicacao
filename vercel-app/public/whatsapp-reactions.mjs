import {emojiCatalogue} from './emoji-catalogue.mjs';
export const whatsappReactionChoices=['👍','❤️','😂','😮','😢','🙏','👏','✅'];
const available=new Set(emojiCatalogue.map(([emoji])=>emoji));
export const isWhatsAppReaction=value=>typeof value==='string'&&(value===''||available.has(value));
