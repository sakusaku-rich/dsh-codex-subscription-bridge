window.__ModuleLoader__.load({
  id: 'dsh-codex-subscription-bridge',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
    function tabId() {
      const key = 'dsh-codex-subscription-ui-tab';
      try { const existing = window.sessionStorage.getItem(key); if (validId(existing)) return existing; } catch {}
      let id;
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') id = crypto.randomUUID();
      else if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
        id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      }
      if (!validId(id)) return null;
      // Only a random tab identifier persists; device codes and tokens never do.
      try { window.sessionStorage.setItem(key, id); } catch {}
      return id;
    }
    const CLIENT_ID = tabId();
    const PREFIX = 'codex-subscription-auth/';
    const labels = {
      idle: 'No device login is running.', starting: 'Starting device login…',
      waiting: 'Approve the device code in your browser.', cancelling: 'Cancelling login…',
      signed_in: 'Device login completed.', cancelled: 'Login cancelled.',
      failed: 'Login failed. Refresh status or try again.',
    };
    const errorCodes = new Set(['AUTH_REQUIRED','AUTH_STORE_INVALID','AUTH_BUSY','RATE_LIMITED','CONFIG_INVALID','INPUT_UNSUPPORTED','MODEL_UNAVAILABLE','PROTOCOL_INVALID','UPSTREAM_FAILED','LIMIT_EXCEEDED','TIMEOUT','ABORTED','CLOSED','NODE_VERSION_UNSUPPORTED','PLATFORM_UNSUPPORTED']);
    const safeError = value => errorCodes.has(value?.code) ? `The operation could not complete (${value.code}). Refresh status or try again.` : 'The operation could not complete. Refresh status and try again.';
    function Card({ connection }) {
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const mounted = React.useRef(false);
      const current = React.useRef(null);
      const request = React.useRef(null);
      const generation = React.useRef(0);
      const call = async (action, args = {}) => {
        const controller = new AbortController(); request.current?.abort(); request.current = controller;
        const revision = ++generation.current;
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const result = await connection.rpc.call('/api', PREFIX + action, { clientId: CLIENT_ID, ...args }, controller.signal);
          if (!mounted.current || revision !== generation.current) return;
          if (!result.ok) { setError(safeError(result.error)); return; }
          const value = result.value;
          if (!value || !Object.hasOwn(labels, value.phase)) { setError('The authentication status is unavailable.'); return; }
          current.current = value; setState(value); setError('');
        } catch {
          if (mounted.current && revision === generation.current) setError('Unable to reach Harness. Refresh status after reconnecting.');
        } finally { clearTimeout(timer); if (request.current === controller) request.current = null; }
      };
      React.useEffect(() => {
        if (!connection.isLoopback || !CLIENT_ID) return;
        mounted.current = true; void call('status');
        const timer = setInterval(() => { if (current.current?.active && !request.current) void call('status'); }, 1000);
        return () => { mounted.current = false; generation.current++; request.current?.abort(); clearInterval(timer); };
      }, [connection]);
      const action = async (name, args) => {
        setBusy(true);
        if (name === 'cancel') setState(previous => previous ? { ...previous, device: undefined, phase: 'cancelling' } : previous);
        try { await call(name, args); } finally { if (mounted.current) setBusy(false); }
      };
      if (!connection.isLoopback || !CLIENT_ID) return h('section', null, h('h2', null, 'ChatGPT subscription'), h('p', null, 'Open this settings page locally in a browser with secure randomness support.'));
      const code = state?.owned && state.phase === 'waiting' && typeof state.device?.code === 'string' && /^[A-Za-z0-9-]{1,128}$/u.test(state.device.code) ? state.device.code : null;
      const local = state?.local?.auth;
      const localText = local === 'stored' ? 'A local subscription login is stored.' : ['expired', 'refresh_due'].includes(local) ? 'The stored login may refresh during normal use.' : local === 'relogin_required' ? 'Log in again to recover the local authentication state.' : local === 'missing' ? 'No local subscription login is stored.' : 'Local authentication has not been checked or is busy.';
      return h('section', { style: { padding: '16px', maxWidth: '640px' }, 'aria-label': 'ChatGPT subscription authentication' },
        h('h2', null, 'ChatGPT subscription'),
        h('p', null, 'Connect using a dedicated ChatGPT device login. Existing Codex and Hermes logins are not imported.'),
        h('p', null, 'Local status does not verify server-side access or subscription allowance.'),
        h('div', { role: 'status', 'aria-live': 'polite' }, h('p', null, localText), h('p', null, state ? labels[state.phase] : 'Checking authentication…'),
          state?.active && !state.owned ? h('p', null, 'A login is running in another window. Wait for it to finish.') : null),
        error || state?.phase === 'failed' ? h('p', { role: 'alert' }, error || safeError(state.error)) : null,
        code ? h('div', null,
          h('p', null, 'One-time sign-in code: ', h('code', { style: { userSelect: 'all', fontSize: '1.25em' } }, code)),
          h('a', { href: 'https://auth.openai.com/codex/device', target: '_blank', rel: 'noopener noreferrer' }, 'Open ChatGPT sign-in page'),
          h('p', null, 'Enter this code on the OpenAI sign-in page. It is not an access token. Keep it private; this page updates after approval.')) : null,
        h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '16px' } },
          h('button', { type: 'button', disabled: busy || Boolean(state?.active), onClick: () => void action('login') }, local === 'stored' ? 'Log in again' : 'Log in'),
          h('button', { type: 'button', disabled: busy, onClick: () => void action('status') }, 'Refresh status'),
          state?.active && state.owned ? h('button', { type: 'button', disabled: busy || state.phase === 'cancelling', onClick: () => void action('cancel', { attemptId: state.attemptId }) }, 'Cancel login') : null,
          h('button', { type: 'button', disabled: busy || Boolean(state?.active) || local === 'missing', onClick: () => {
            if (window.confirm('Remove this plugin’s local login? Server-side authorization is not revoked.')) void action('logout');
          } }, 'Log out')),
        h('p', null, 'Credentials stay on this computer in the backend. The settings page never receives access or refresh tokens.'));
    }
    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'codex-subscription', order: 45,
          label: () => 'ChatGPT subscription', inject: () => ({ connection: ctx.connection }),
        }, Card));
      },
    };
  },
});
