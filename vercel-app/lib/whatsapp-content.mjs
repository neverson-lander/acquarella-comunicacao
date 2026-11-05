export function createWhatsAppContent({pool}){
  return {
    async captureDeletion(account,message,{actor=null,source='whatsapp'}={}){
      if(!message.deletion?.target)return;
      await pool.query(`insert into whatsapp_deletions(tenant,account,customer,target_external,event_external,deleted_at,actor,source)
        values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(account,customer,target_external) do update
        set actor=coalesce(whatsapp_deletions.actor,excluded.actor),
          source=case when whatsapp_deletions.source='whatsapp' or excluded.source='whatsapp' then 'whatsapp' else 'central' end`,
        [account.tenant,account.id,message.customer,message.deletion.target,message.external,message.timestamp,actor,source]);
    },
    async deletions(conversation){
      return (await pool.query('select target_external,deleted_at,actor,source from whatsapp_deletions where tenant=$1 and account=$2 and customer=$3',[conversation.tenant,conversation.account,conversation.customer])).rows;
    },
    async captureReaction(account,message){
      const reaction=message.reaction;
      if(!reaction?.target)return;
      await pool.query(`insert into whatsapp_reactions(tenant,account,customer,event_external,target_external,emoji,created,from_me)
        values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,[account.tenant,account.id,message.customer,message.external,reaction.target,reaction.emoji,message.timestamp,message.fromMe===true]);
    },
    async reactions(conversation){
      return (await pool.query(`select target_external,emoji,created,from_me from
        (select distinct on(target_external,from_me) target_external,emoji,created,from_me from whatsapp_reactions
        where tenant=$1 and account=$2 and customer=$3 order by target_external,from_me,created desc,received_order desc) latest
        where emoji<>''`,[conversation.tenant,conversation.account,conversation.customer])).rows;
    }
  };
}
