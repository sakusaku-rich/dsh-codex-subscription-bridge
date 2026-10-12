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
