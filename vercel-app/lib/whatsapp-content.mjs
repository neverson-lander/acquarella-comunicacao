export function createWhatsAppContent({pool}){
  return {
    async captureReaction(account,message){
      const reaction=message.reaction;
      if(!reaction?.target)return;
      await pool.query(`insert into whatsapp_reactions(tenant,account,customer,event_external,target_external,emoji,created)
        values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,[account.tenant,account.id,message.customer,message.external,reaction.target,reaction.emoji,message.timestamp]);
    },
    async reactions(conversation){
      return (await pool.query(`select target_external,emoji,created from
        (select distinct on(target_external) target_external,emoji,created from whatsapp_reactions
        where tenant=$1 and account=$2 and customer=$3 order by target_external,created desc,received_order desc) latest
        where emoji<>''`,[conversation.tenant,conversation.account,conversation.customer])).rows;
    }
  };
}
