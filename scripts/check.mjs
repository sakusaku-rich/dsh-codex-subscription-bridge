import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// Checked trees and the subdirectories that hold their own source modules.
// Recursion stays explicit so dependency trees such as node_modules, which
// contain files this project does not own, are never walked.
const trees = ['.', 'src', 'scripts', 'scripts/lib', 'test', 'test/integration'];
for (const directory of trees) {
  for (const file of readdirSync(directory).filter((name) => /\.m?js$/u.test(name))) {
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(1);
  }
}
// The syntax walk above only covers plain JavaScript, so the TypeScript sources
// are checked by the compiler itself; `--noEmit` keeps this a check-only step.
const compiled = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(1);
