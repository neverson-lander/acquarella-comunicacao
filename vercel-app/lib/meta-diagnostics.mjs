export function inspectWhatsAppWindow(seen, now = Date.now()) {
  const lastInbound = Number(seen);
  const expiresAt = lastInbound + 86400000;
  return { open: Number.isFinite(lastInbound) && lastInbound > 0 && lastInbound <= now && expiresAt > now, expiresAt: Number.isFinite(lastInbound) && lastInbound > 0 ? expiresAt : null };
}

export async function inspectMetaAccount(account, secrets, fetcher = fetch) {
  const host = account.channel === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  const external = account.channel === 'instagram' ? secrets.instagramApiId || account.external : account.external;
  const fields = account.channel === 'whatsapp' ? 'id,display_phone_number,verified_name' : account.channel === 'instagram' ? 'id,username' : 'id,name';
  async function read(path) {
    const response = await fetcher(`https://${host}/${secrets.version || 'v26.0'}/${path}`, {
      headers: { Authorization: `Bearer ${secrets.token}` }, signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) return { ok: false, status: response.status, code: result.error?.code, subcode: result.error?.error_subcode };
    return { ok: true, result };
  }
  if (account.mode !== 'live' || !external || !secrets.token) return { connected: false, reason: 'not_configured' };
  const profile = await read(`${encodeURIComponent(external)}?fields=${fields}`);
  if (!profile.ok) return { connected: false, reason: profile.code === 190 ? 'invalid_token' : 'meta_rejected', ...profile };
  const result = { connected: true, profile: Object.fromEntries(fields.split(',').map(field => [field, profile.result[field]])) };
  if (account.channel === 'messenger') {
    const subscriptions = await read(`${encodeURIComponent(external)}/subscribed_apps?fields=id,subscribed_fields`);
    result.subscriptions = subscriptions.ok ? (subscriptions.result.data || []).map(app => ({ id: app.id, fields: app.subscribed_fields })) : { ok: false, code: subscriptions.code };
  }
  return result;
}
