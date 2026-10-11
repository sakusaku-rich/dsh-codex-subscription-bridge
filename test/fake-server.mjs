import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const mode = process.argv[2];
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
if (mode === 'descendant') {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
  send({ method: 'fixture/child', params: { pid: child.pid } });
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, 'id')) return;
  if (mode === 'hang') return;
  if (mode === 'malformed') { process.stdout.write('not-json secret-test-value\n'); return; }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(1024 * 1024 + 1)); return; }
  if (mode === 'stderr-flood') { process.stderr.write('x'.repeat(1024 * 1024 + 1)); return; }
  if (mode === 'utf8') { process.stdout.write(Buffer.from([0xff, 10])); return; }
  if (mode === 'error') {
    process.stderr.write('Authorization: Bearer secret-test-value\n');
    send({ id: request.id, error: { code: -1, message: 'secret-test-value', data: { access_token: 'secret-test-value' } } }); return;
  }
  send({ id: request.id, result: { ok: true } });
});
setInterval(() => {}, 1000);
