import {canonicalPhone} from './whatsapp-phone.mjs';
import {contactPhoneVariants} from '../public/contact-domain.mjs';

// New conversations always use the same mobile representation, so the unique
// (account, customer) constraint also covers simultaneous arrivals of aliases.
export const whatsappCustomerPhone=phone=>/^55[1-9]\d\d{8,9}$/.test(phone)?contactPhoneVariants(phone)[0]||phone:canonicalPhone(phone)||phone;

// The agenda can use the ninth digit while WhatsApp delivers the legacy ID.
// Prefer an established attendance over an empty automation-only conversation.
export async function findWhatsAppConversation(one,account,phone){
  return one(`select * from conversations where tenant=$1 and account=$2 and
    (customer=$3 or (case when customer ~ '^55[1-9][0-9]9[6-9][0-9]{7}$'
      then substring(customer,1,4)||substring(customer,6) else customer end)=$4)
    order by attendance_eligible desc,(customer=$3) desc,updated desc,id limit 1`,
    [account.tenant,account.id,phone,canonicalPhone(phone)||phone]);
}
