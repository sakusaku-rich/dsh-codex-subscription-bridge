import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, assertPlatform } from '../src/runtime.js';
assertNodeVersion(); assertPlatform();
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--directory' || !isAbsolute(args[1] ?? '') || /[\x00\r\n]/u.test(args[1])) throw new Error('Run npm run prepare:desktop -- --directory <absolute new directory>.');
const root = args[1];
const app = '/Applications/DeepSeek Harness.app';
const executable = join(app, 'Contents/MacOS/DeepSeek Harness');
const resources = join(app, 'Contents/Resources');
const modules = join(resources, 'app.asar/dsh/node_modules');
const facts = JSON.parse(execFileSync(executable, ['-p', `JSON.stringify({versions:process.versions,app:require(${JSON.stringify(join(resources, 'app.asar/package.json'))}),cordis:require(${JSON.stringify(join(modules, '@deepseek-ai/cordis/package.json'))}).version,llm:require(${JSON.stringify(join(modules, '@deepseek-ai/dsh-llm/package.json'))}).version})`], { env: { ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }));
if (facts.app.version !== '0.2.0-rc.2' || facts.versions.node !== '24.18.1' || facts.versions.electron !== '44.0.0' || facts.cordis !== '4.0.4' || facts.llm !== '0.2.0-rc.2') throw new Error('The installed Desktop does not match the verified host.');
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
execFileSync(process.execPath, [join(repo, 'scripts/prepare-profile.mjs'), ...args], { env: process.env, stdio: 'pipe', timeout: 45000 });
const harness = join(root, 'harness'); const profile = join(harness, 'profiles/desktop');
await rename(join(harness, 'profiles/subscription-web'), profile);
for (const name of ['cordis', 'dsh-llm']) {
  const link = join(profile, 'node_modules/@deepseek-ai', name);
  // Desktop's runtime resolver supplies exact host peers from its ASAR tree.
  await unlink(link);
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const home = join(root, 'home');
const env = { HOME: home, DSH_HOME: harness, XDG_CONFIG_HOME: join(root, 'xdg'), XDG_CACHE_HOME: join(root, 'cache'), LANG: 'C.UTF-8', PATH: '/usr/bin:/bin', DSH_TELEMETRY_DISABLED: 'true', DSH_PRIMARY_RUNTIME: '' };
const environment = Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(' ');
await writeFile(join(root, 'auth.sh'), `#!/bin/sh\nexec env -i ${environment} ELECTRON_RUN_AS_NODE=1 ${quote(executable)} ${quote(join(profile, 'node_modules/dsh-codex-subscription-bridge/src/auth-cli.js'))} "$@"\n`, { mode: 0o700 });
await writeFile(join(root, 'desktop.sh'), `#!/bin/sh\ncd ${quote(join(root, 'workspace'))} || exit 1\nexec env -i ${environment} ${quote(executable)}\n`, { mode: 0o700 });
await unlink(join(root, 'start.sh'));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, surface: 'desktop', desktop: facts.app.version, electron: facts.versions.electron, hostNode: facts.versions.node, desktopBuildCommit: facts.app.dshBuildCommit }, null, 2));
console.log(`Prepared Desktop verification profile: ${root}\nDiagnose: sh ${quote(join(root, 'auth.sh'))} doctor\nLogin: sh ${quote(join(root, 'auth.sh'))} login\nClose all existing Desktop instances, then start: sh ${quote(join(root, 'desktop.sh'))}\nHarness data and subscription credentials use this new directory. Electron OS preferences and updater state are not claimed to be isolated. No login or GUI was started.`);
