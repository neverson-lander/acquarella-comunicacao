const inbound = c => (c.messages || []).filter(m => m.direction === 'in');

// Failed/simulated outbound messages do not end a customer's wait.
export function waitingSince(c) {
  const lastReply = Math.max(0, ...(c.messages || []).filter(m => m.direction === 'out' && m.state === 'sent').map(m => Number(m.created)));
  const pending = inbound(c).filter(m => Number(m.created) >= lastReply);
  return pending.length ? Math.min(...pending.map(m => Number(m.created))) : null;
}
export function waitLabel(since, now = Date.now()) {
  if (!since) return 'Sem espera pendente';
  const minutes = Math.max(0, Math.floor((now - since) / 60000));
  if (minutes < 1) return 'Agora';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${Math.floor(minutes / 1440)} d ${Math.floor(minutes % 1440 / 60)} h`;
}
export function prioritize(conversations, scope, unread = new Map()) {
  return [...conversations].sort((a, b) => {
    if (scope === 'queue') return (waitingSince(a) ?? Number(a.last_inbound)) - (waitingSince(b) ?? Number(b.last_inbound)) || a.id.localeCompare(b.id);
    return Number(!!unread.get(b.id)) - Number(!!unread.get(a.id)) || Number(b.updated) - Number(a.updated);
  });
}

// A bounded observer follows authorized snapshots only, never alerts on initial
// history, outgoing messages, or historical conversations becoming visible.
export function createMessageObserver() {
  let identity, since = 0, seen = new Map();
  function reset() { identity = null; since = 0; seen.clear(); }
  function observe(snapshot) {
    const key = `${snapshot.tenant.id || snapshot.tenant.name}:${snapshot.user.id}`;
    const initial = key !== identity;
    if (initial) { reset(); identity = key; }
    const changes = [];
    const nextSeen = new Map();
    for (const c of snapshot.conversations) {
      const messages = inbound(c);
      const previous = seen.get(c.id);
      const fresh = initial ? [] : messages.filter(m => !previous?.has(m.id) && (previous || Number(m.created) >= since));
      nextSeen.set(c.id, new Set(messages.map(m => m.id)));
      const kind = c.status === 'open' && !c.assigned_to ? 'queue' : c.status === 'open' && c.assigned_to === snapshot.user.id ? 'mine' : null;
      if (fresh.length && kind) changes.push({conversation: c.id, kind, count: fresh.length, message: fresh.at(-1), name: c.name, account: c.account});
    }
    seen = nextSeen;
    since = Number(snapshot.server_time) || Date.now();
    return changes;
  }
  return {observe, reset};
}
