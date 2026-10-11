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
    // Presentation follows the OpenAI interface language: near-monochrome surfaces,
    // pill actions, restrained green accents, and automatic light/dark palettes.
    const PANEL_CSS = [
      '.dshcsb{--dshcsb-surface:#ffffff;--dshcsb-field:#f5f5f4;--dshcsb-text:#0d0d0d;--dshcsb-muted:#8f8f8f;',
      '--dshcsb-border:rgba(0,0,0,.12);--dshcsb-primary-bg:#0d0d0d;--dshcsb-primary-fg:#ffffff;--dshcsb-primary-hover:#2f2f2f;',
      '--dshcsb-secondary-hover:rgba(0,0,0,.06);--dshcsb-ok:#10a37f;--dshcsb-busy:#d97706;--dshcsb-bad:#dc2626;--dshcsb-idle:#9ca3af;',
      '--dshcsb-alert-bg:rgba(220,38,38,.07);--dshcsb-alert-border:rgba(220,38,38,.35);--dshcsb-alert-text:#b91c1c;',
      'font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif;color:var(--dshcsb-text);}',
      '@media (prefers-color-scheme: dark){.dshcsb{--dshcsb-surface:#212121;--dshcsb-field:#2f2f2f;--dshcsb-text:#ececec;--dshcsb-muted:#b4b4b4;',
      '--dshcsb-border:rgba(255,255,255,.14);--dshcsb-primary-bg:#ececec;--dshcsb-primary-fg:#0d0d0d;--dshcsb-primary-hover:#d6d6d6;',
      '--dshcsb-secondary-hover:rgba(255,255,255,.08);--dshcsb-ok:#2fd39f;--dshcsb-busy:#f5a623;--dshcsb-bad:#f87171;--dshcsb-idle:#8e8e8e;',
      '--dshcsb-alert-bg:rgba(248,113,113,.12);--dshcsb-alert-border:rgba(248,113,113,.4);--dshcsb-alert-text:#fca5a5;}}',
      '.dshcsb *{box-sizing:border-box;}',
      '.dshcsb-card{border:1px solid var(--dshcsb-border);border-radius:16px;background:var(--dshcsb-surface);padding:20px 24px 24px;display:flex;flex-direction:column;gap:14px;}',
      '.dshcsb-title{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em;line-height:24px;}',
      '.dshcsb-subtitle{margin:0;font-size:13px;line-height:20px;color:var(--dshcsb-muted);}',
      '.dshcsb-status{display:flex;flex-direction:column;gap:6px;background:var(--dshcsb-field);border-radius:12px;padding:12px 16px;}',
      '.dshcsb-row{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;line-height:20px;}',
      '.dshcsb-dot{width:8px;height:8px;border-radius:9999px;flex:none;background:var(--dshcsb-idle);}',
      '.dshcsb-dot-ok{background:var(--dshcsb-ok);}.dshcsb-dot-busy{background:var(--dshcsb-busy);}.dshcsb-dot-bad{background:var(--dshcsb-bad);}',
      '.dshcsb-alert{margin:0;padding:10px 14px;border:1px solid var(--dshcsb-alert-border);background:var(--dshcsb-alert-bg);color:var(--dshcsb-alert-text);border-radius:12px;font-size:13px;line-height:20px;}',
      '.dshcsb-code{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dshcsb-border);border-radius:12px;padding:16px;background:var(--dshcsb-field);}',
      '.dshcsb-code-label{margin:0;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dshcsb-muted);}',
      '.dshcsb-code-value{margin:0;font-family:ui-monospace,"SFMono-Regular","SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:24px;line-height:32px;letter-spacing:.14em;font-weight:500;word-break:break-all;}',
      '.dshcsb-code-hint{margin:0;font-size:12px;line-height:18px;color:var(--dshcsb-muted);}',
      '.dshcsb-code-copy{margin:0;padding:0;border:0;background:none;color:inherit;cursor:pointer;text-align:left;transition:opacity .15s ease;}',
      '.dshcsb-code-copy:hover{opacity:.7;}',
      '.dshcsb-code-copy:focus-visible{outline:2px solid var(--dshcsb-ok);outline-offset:2px;}',
      '.dshcsb-code-feedback{margin:0;font-size:12px;line-height:18px;color:var(--dshcsb-ok);}',
      '.dshcsb-code-feedback-bad{color:var(--dshcsb-bad);}',
      '.dshcsb-cta{display:inline-flex;align-items:center;gap:6px;border-radius:9999px;padding:8px 16px;background:var(--dshcsb-primary-bg);color:var(--dshcsb-primary-fg);font-size:13px;font-weight:600;line-height:20px;text-decoration:none;transition:background .15s ease;align-self:flex-start;}',
      '.dshcsb-cta:hover{background:var(--dshcsb-primary-hover);}',
      '.dshcsb-actions{display:flex;flex-wrap:wrap;gap:10px;}',
      '.dshcsb-btn{border-radius:9999px;padding:8px 16px;font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease;background:transparent;border:1px solid var(--dshcsb-border);color:var(--dshcsb-text);}',
      '.dshcsb-btn:hover:not(:disabled){background:var(--dshcsb-secondary-hover);}',
      '.dshcsb-btn:disabled{opacity:.45;cursor:default;}',
      '.dshcsb-primary{background:var(--dshcsb-primary-bg);border-color:var(--dshcsb-primary-bg);color:var(--dshcsb-primary-fg);}',
      '.dshcsb-primary:hover:not(:disabled){background:var(--dshcsb-primary-hover);border-color:var(--dshcsb-primary-hover);}',
      '.dshcsb-cta:focus-visible,.dshcsb-btn:focus-visible{outline:2px solid var(--dshcsb-ok);outline-offset:2px;}',
      '.dshcsb-note{margin:0;font-size:12px;line-height:18px;color:var(--dshcsb-muted);}',
    ].join('');
    const phaseDot = { idle: 'idle', starting: 'busy', waiting: 'busy', cancelling: 'busy', signed_in: 'ok', cancelled: 'idle', failed: 'bad' };
    const localDot = { stored: 'ok', expired: 'busy', refresh_due: 'busy', relogin_required: 'bad', missing: 'idle' };
    const Dot = ({ tone }) => h('span', { className: `dshcsb-dot${tone === 'idle' ? '' : ` dshcsb-dot-${tone}`}`, 'aria-hidden': 'true' });
    function Card({ connection }) {
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const mounted = React.useRef(false);
      const current = React.useRef(null);
      const request = React.useRef(null);
      const generation = React.useRef(0);
      const [copied, setCopied] = React.useState('');
      const copyTimer = React.useRef(null);
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
      const code = state?.owned && state.phase === 'waiting' && typeof state.device?.code === 'string' && /^[A-Za-z0-9-]{1,128}$/u.test(state.device.code) ? state.device.code : null;
      React.useEffect(() => {
        setCopied('');
        return () => { if (copyTimer.current) { clearTimeout(copyTimer.current); copyTimer.current = null; } };
      }, [code]);
      const showCopyResult = ok => {
        if (!mounted.current) return;
        setCopied(ok ? 'copied' : 'failed');
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => { copyTimer.current = null; if (mounted.current) setCopied(''); }, 2500);
      };
      const copyCode = async () => {
        if (!code) return;
        try {
          if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(code); showCopyResult(true); return; }
          const area = document.createElement('textarea');
          area.value = code; area.setAttribute('readonly', '');
          area.style.position = 'fixed'; area.style.opacity = '0';
          document.body.appendChild(area); area.select();
          let wrote = false;
          try { wrote = document.execCommand('copy'); } finally { area.remove(); }
          showCopyResult(wrote);
        } catch { showCopyResult(false); }
      };
      const action = async (name, args) => {
        setBusy(true);
        if (name === 'cancel') setState(previous => previous ? { ...previous, device: undefined, phase: 'cancelling' } : previous);
        try { await call(name, args); } finally { if (mounted.current) setBusy(false); }
      };
      const frame = children => h('section', { className: 'dshcsb', style: { maxWidth: '560px' }, 'aria-label': 'ChatGPT subscription authentication' },
        h('style', null, PANEL_CSS), h('div', { className: 'dshcsb-card' }, children));
      if (!connection.isLoopback || !CLIENT_ID) {
        return frame([
          h('h2', { className: 'dshcsb-title' }, 'ChatGPT subscription'),
          h('p', { className: 'dshcsb-subtitle' }, 'Open this settings page locally in a browser with secure randomness support.'),
        ]);
      }
      const local = state?.local?.auth;
      const localText = local === 'stored' ? 'A local subscription login is stored.' : ['expired', 'refresh_due'].includes(local) ? 'The stored login may refresh during normal use.' : local === 'relogin_required' ? 'Log in again to recover the local authentication state.' : local === 'missing' ? 'No local subscription login is stored.' : 'Local authentication has not been checked or is busy.';
      const alertText = error || state?.phase === 'failed' ? error || safeError(state.error) : null;
      return frame([
        h('h2', { className: 'dshcsb-title' }, 'ChatGPT subscription'),
        h('p', { className: 'dshcsb-subtitle' }, 'Connect using a dedicated ChatGPT device login. Existing logins are not imported.'),
        h('div', { className: 'dshcsb-status', role: 'status', 'aria-live': 'polite' },
          h('p', { className: 'dshcsb-row' }, h(Dot, { tone: localDot[local] ?? 'idle' }), localText),
          h('p', { className: 'dshcsb-row' }, h(Dot, { tone: state ? phaseDot[state.phase] : 'busy' }), state ? labels[state.phase] : 'Checking authentication…'),
          state?.active && !state.owned ? h('p', { className: 'dshcsb-row dshcsb-muted' }, 'A login is running in another window. Wait for it to finish.') : null,
          h('p', { className: 'dshcsb-note' }, 'Local status does not verify server-side access or subscription allowance.')),
        alertText ? h('p', { className: 'dshcsb-alert', role: 'alert' }, alertText) : null,
        code ? h('div', { className: 'dshcsb-code' },
          h('p', { className: 'dshcsb-code-label' }, 'One-time sign-in code'),
          h('button', { className: 'dshcsb-code-value dshcsb-code-copy', type: 'button', style: { userSelect: 'all' }, 'aria-label': 'Copy the one-time sign-in code', title: 'Click to copy the code', onClick: () => void copyCode() }, code),
          h('p', { className: 'dshcsb-code-hint' }, 'Click the code to copy it, then enter it on the OpenAI sign-in page. It is not an access token. Keep it private; this page updates after approval.'),
          copied === 'copied' ? h('p', { className: 'dshcsb-code-feedback', role: 'status' }, 'Copied to the clipboard.') : copied === 'failed' ? h('p', { className: 'dshcsb-code-feedback dshcsb-code-feedback-bad', role: 'status' }, 'Copy failed. Select the code and copy it manually.') : null,
          h('a', { className: 'dshcsb-cta', href: 'https://auth.openai.com/codex/device', target: '_blank', rel: 'noopener noreferrer' }, 'Open ChatGPT sign-in page')) : null,
        h('div', { className: 'dshcsb-actions' },
          h('button', { className: 'dshcsb-btn dshcsb-primary', type: 'button', disabled: busy || Boolean(state?.active), onClick: () => void action('login') }, local === 'stored' ? 'Log in again' : 'Log in'),
          h('button', { className: 'dshcsb-btn', type: 'button', disabled: busy, onClick: () => void action('status') }, 'Refresh status'),
          state?.active && state.owned ? h('button', { className: 'dshcsb-btn', type: 'button', disabled: busy || state.phase === 'cancelling', onClick: () => void action('cancel', { attemptId: state.attemptId }) }, 'Cancel login') : null,
          h('button', { className: 'dshcsb-btn', type: 'button', disabled: busy || Boolean(state?.active) || local === 'missing', onClick: () => {
            if (window.confirm('Remove this plugin’s local login? Server-side authorization is not revoked.')) void action('logout');
          } }, 'Log out')),
        h('p', { className: 'dshcsb-note' }, 'Credentials stay on this computer in the backend. The settings page never receives access or refresh tokens.'),
      ]);
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
