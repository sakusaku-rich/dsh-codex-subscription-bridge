import { BridgeError } from './errors.js';
import type { Context } from '@deepseek-ai/cordis';

/** The launch-environment shape this bridge reads from the host service. */
interface LaunchEnvironmentSnapshot {
  getFrom: (name: string, source: readonly string[]) => { value?: unknown } | undefined;
}

/** Select authentication location only from the launcher-inherited environment. */
export function authenticationEnvironment(ctx: Context, inherited: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  // `ctx.get` answers with an untyped service; assert only the shape read here.
  const snapshot = typeof ctx.get === 'function' ? ctx.get('launchEnvironment') as LaunchEnvironmentSnapshot | undefined : undefined;
  if (snapshot !== undefined && typeof snapshot.getFrom !== 'function') throw new BridgeError('CONFIG_INVALID');
  const result: Record<string, string> = {};
  for (const name of process.versions.electron ? ['HOME', 'DSH_HOME'] : ['HOME']) {
    const value = snapshot === undefined ? inherited[name] : snapshot.getFrom(name, ['process'])?.value;
    if (value !== undefined) {
      if (typeof value !== 'string') throw new BridgeError('CONFIG_INVALID');
      result[name] = value;
    }
  }
  return Object.freeze(result);
}
