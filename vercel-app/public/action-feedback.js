const active = new Set();
const locked = new WeakSet();

export const actionsPending = () => active.size > 0;

function showStatus() {
  let status = document.getElementById('action-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'action-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    document.body.append(status);
  }
  status.hidden = !active.size;
  status.textContent = [...active].at(-1)?.label || '';
}

// Keep feedback alive even when a refresh replaces the initiating button.
export async function withFeedback(button, label, task, scope = button) {
  if (scope && locked.has(scope)) return;
  if (scope) locked.add(scope);
  const operation = {label};
  active.add(operation);
  const controls = scope?.matches('form')
    ? [...scope.querySelectorAll('button')]
    : button ? [button] : [];
  const previous = controls.map(control => [control, control.disabled]);
  const replacements = new Map();
  const scopeId = scope?.id;
  const buttonId = button?.id;
  const followRender = new MutationObserver(() => {
    const currentScope = scopeId && document.getElementById(scopeId);
    if (!currentScope || currentScope === scope) return;
    const currentButton = buttonId ? document.getElementById(buttonId)
      : currentScope.matches('form') ? currentScope.querySelector('button.primary') : currentScope;
    if (replacements.has(currentScope)) return;
    const currentControls = currentScope.matches('form') ? [...currentScope.querySelectorAll('button')] : [currentScope];
    replacements.set(currentScope, {busy: currentScope.getAttribute('aria-busy'), controls: currentControls.map(c => [c, c.disabled]), button: currentButton, html: currentButton?.innerHTML, ariaLabel: currentButton?.getAttribute('aria-label')});
    currentScope.setAttribute('aria-busy', 'true');
    for (const control of currentControls) control.disabled = true;
    if (currentButton?.matches('button')) {
      currentButton.classList.add('action-loading');
      currentButton.textContent = label;
      currentButton.setAttribute('aria-label', label);
    }
  });
  followRender.observe(document.getElementById('app') || document.body, {childList: true, subtree: true});
  const html = button?.innerHTML;
  const ariaLabel = button?.getAttribute('aria-label');
  const busy = scope?.getAttribute('aria-busy');
  const dialog = scope?.closest('dialog');
  const preventClose = event => event.preventDefault();
  dialog?.addEventListener('cancel', preventClose);
  const close = dialog?.querySelector('#close-modal');
  const closeDisabled = close?.disabled;
  if (close) close.disabled = true;
  if (scope) scope.setAttribute('aria-busy', 'true');
  for (const [control] of previous) control.disabled = true;
  if (button?.matches('button')) {
    button.classList.add('action-loading');
    button.textContent = label;
    button.setAttribute('aria-label', label);
  }
  showStatus();
  try {
    return await task();
  } finally {
    followRender.disconnect();
    active.delete(operation);
    if (scope) {
      locked.delete(scope);
      if (busy === null) scope.removeAttribute('aria-busy');
      else scope.setAttribute('aria-busy', busy);
    }
    for (const [control, disabled] of previous) control.disabled = disabled;
    if (button?.matches('button')) {
      button.innerHTML = html;
      button.classList.remove('action-loading');
      if (ariaLabel === null) button.removeAttribute('aria-label');
      else button.setAttribute('aria-label', ariaLabel);
    }
    for (const [replacement, saved] of replacements) {
      if (saved.busy === null) replacement.removeAttribute('aria-busy');
      else replacement.setAttribute('aria-busy', saved.busy);
      for (const [control, disabled] of saved.controls) control.disabled = disabled;
      if (saved.button?.matches('button')) {
        saved.button.innerHTML = saved.html;
        saved.button.classList.remove('action-loading');
        if (saved.ariaLabel === null) saved.button.removeAttribute('aria-label');
        else saved.button.setAttribute('aria-label', saved.ariaLabel);
      }
    }
    dialog?.removeEventListener('cancel', preventClose);
    if (close) close.disabled = closeDisabled;
    showStatus();
  }
}

export function action(handler, label) {
  return function(event) {
    if (event.type === 'submit') event.preventDefault();
    if ([...active].some(operation => operation.label === label)) return;
    const scope = event.currentTarget;
    const button = event.type === 'submit'
      ? event.submitter || scope.querySelector('button[type="submit"], button.primary')
      : scope;
    return withFeedback(button, label, () => handler.call(this, event), scope);
  };
}
