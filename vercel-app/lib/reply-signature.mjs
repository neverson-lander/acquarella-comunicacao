const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export async function replySigner({pool,permitted,user,account,signatureUser}){
 if(signatureUser===undefined)return user;
 if(typeof signatureUser!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(signatureUser))fail('Selecione uma assinatura válida.');
 if(signatureUser===user.id)return user;
 if(user.role!=='admin')fail('Apenas administradores podem enviar em nome de outro usuário.',403);
 const signer=(await pool.query('select id,tenant,name,role,accounts from users where id=$1 and tenant=$2',[signatureUser,user.tenant])).rows[0];
 if(!signer||signer.role==='viewer'||!permitted(signer,account))fail('O usuário da assinatura não tem acesso a este canal.',403);
 return signer;
}
