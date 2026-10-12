import { BridgeError } from './errors.js';

/** Select authentication location only from the launcher-inherited environment. */
export function authenticationEnvironment(ctx, inherited = process.env) {
  const snapshot = typeof ctx.get === 'function' ? ctx.get('launchEnvironment') : undefined;
  if (snapshot !== undefined && typeof snapshot.getFrom !== 'function') throw new BridgeError('CONFIG_INVALID');
  const result = {};
  for (const name of process.versions.electron ? ['HOME', 'DSH_HOME'] : ['HOME']) {
    const value = snapshot === undefined ? inherited[name] : snapshot.getFrom(name, ['process'])?.value;
    if (value !== undefined) {
      if (typeof value !== 'string') throw new BridgeError('CONFIG_INVALID');
      result[name] = value;
    }
  }
  return Object.freeze(result);
}
