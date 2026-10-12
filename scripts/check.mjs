import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const directory of ['.', 'src', 'scripts', 'test']) {
  for (const file of readdirSync(directory).filter((name) => /\.m?js$/u.test(name))) {
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(1);
  }
}
