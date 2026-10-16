// Supabase Cron runs independently of visitors and Vercel's Hobby cron limits.
// The command references Vault, so credentials do not appear in cron history.
export async function configureAlertScheduler(client) {
  const secret=process.env.CRON_SECRET;
  if(!secret||secret.length<32)throw Error('Configure CRON_SECRET antes de publicar os alertas.');
  const origin=process.env.PUBLIC_ORIGIN||'https://acquarella-comunicacao.vercel.app';
  const url=new URL('/api/internal/waiting-alerts',origin);
  if(url.protocol!=='https:')throw Error('O agendador de alertas exige HTTPS.');
  await client.query('create extension if not exists pg_cron');
  await client.query('create extension if not exists pg_net with schema extensions');
  await client.query('create extension if not exists supabase_vault with schema vault');
  const name='acquarella_waiting_alerts_cron';
  const existing=(await client.query('select id from vault.secrets where name=$1',[name])).rows[0];
  if(existing)await client.query('select vault.update_secret($1,$2,$3)',[existing.id,secret,name]);
  else await client.query('select vault.create_secret($1,$2,$3)',[secret,name,'Autorização do agendador de alertas de atendimento']);
  const command=`delete from public.alert_scheduler_requests where created < now()-interval '7 days';
    insert into public.alert_scheduler_requests(id) select net.http_get(
      url := '${url.href.replaceAll("'","''")}',
      headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='${name}')),
      timeout_milliseconds := 55000);`;
  await client.query('select cron.schedule($1,$2,$3)',['acquarella-waiting-alerts','* * * * *',command]);
  const job=(await client.query('select active,schedule from cron.job where jobname=$1',['acquarella-waiting-alerts'])).rows[0];
  if(!job?.active||job.schedule!=='* * * * *')throw Error('Agendador de alertas não foi ativado.');
}

export async function alertSchedulerStatus(pool) {
  if(process.env.DEPLOYMENT_MODE==='standalone')return globalThis.__acquarellaSchedulerStatus||{scheduled:false,schedule:'* * * * *',latest:null};
  const job=(await pool.query('select active,schedule from cron.job where jobname=$1',['acquarella-waiting-alerts'])).rows[0];
  const response=(await pool.query(`select r.created,n.status_code,n.timed_out,n.error_msg
    from alert_scheduler_requests r left join net._http_response n on n.id=r.id
    order by r.created desc limit 1`)).rows[0];
  return {scheduled:!!job?.active,schedule:job?.schedule,latest:response||null};
}
