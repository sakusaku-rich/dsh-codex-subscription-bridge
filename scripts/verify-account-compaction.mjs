import { Http } from '../src/http.js';
import { events } from '../src/sse.js';
import { AuthStore, authDirectory } from '../src/auth.js';
import { DirectBridge } from '../src/direct.js';
import { BridgeError, failure } from '../src/errors.js';
import { CHECKPOINT_KEY, threshold, requestLimits } from '../src/compaction.js';
import { CONVERSATION_KEY } from '../src/conversation.js';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';

// Owner-authorized real-account measurement only; never part of CI. It reports
// sanitized counters and sizes, never opaque checkpoints, credentials, account
// identifiers or raw authenticated responses.
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
if (!args.includes('--allow-real-account')) {
  throw new Error('Explicit authorization with --allow-real-account is required. Optional: --model <id> --token-budget <n> --max-turns <n>.');
}
const model = value('--model') ?? 'gpt-6-luna';
const tokenBudget = Number(value('--token-budget') ?? 900000);
const maxTurns = Number(value('--max-turns') ?? 3);

// Deterministic prose with a fixed word pool and a fixed mixing order. Repetitive
// text tokenizes far denser than the route measures, so the bytes-per-token
// estimate is recalibrated from each turn that runs.
const WORDS = ['quantum','harbor','measure','settle','window','bridge','render','packet','signal','anchor','thread','volume','circuit','pattern','entropy','carrier','buffer','decode','sample','ledger','orbit','radius','matrix','tensor','pilot','scope','clock','drift','field','layer','node','proxy','quota','relay','trace','vault'];
function prose(sentences, seed = 1) {
  const out = []; let state = seed;
  const pick = () => { state = (state * 1103515245 + 12345) % 2147483648; return WORDS[state % WORDS.length]; };
  for (let index = 0; index < sentences; index += 1) out.push(`The ${pick()} ${pick()}s the ${pick()} ${pick()}.`);
  return { text: out.join(' '), sentences: out.length };
}

const sent = [];
const real = new Http();
const http = new Http(async (url, options) => {
  const response = await real.open(url, options, options.signal);
  const entry = { compactThreshold: null, store: null, chained: null, inputItems: null, bytes: typeof options.body === 'string' ? Buffer.byteLength(options.body) : 0, status: response.status, events: [] };
  if (typeof options.body === 'string') {
    // Shape and counters only. The conversation id itself is a server identifier
    // for a stored conversation, so it is recorded as a boolean, never as a value.
    try {
      const body = JSON.parse(options.body);
      entry.compactThreshold = body.context_management?.[0]?.compact_threshold ?? null;
      entry.store = body.store ?? null;
      entry.chained = body.previous_response_id !== undefined;
      entry.inputItems = Array.isArray(body.input) ? body.input.length : null;
    } catch { /* shape only */ }
  }
  sent.push(entry);
  // Event types only, never content: read a tee'd copy alongside the bridge.
  if (response.ok && response.body) {
    const clone = response.clone();
    void (async () => {
      try { for await (const event of events(clone.body, AbortSignal.timeout(120_000))) entry.events.push(event.type === 'response.completed' ? `completed:${event.response?.status}` : event.type); }
      catch { entry.events.push('READ_FAILED'); }
    })();
  }
  return response;
});

const warnings = [];
const bridge = new DirectBridge(new AuthStore(authDirectory(process.env)), http, {}, { warn: message => warnings.push(message) });
const turns = [];
const history = [];
let spent = 0;

async function turn(text, label) {
  const record = { label, bytes: Buffer.byteLength(text) };
  const chunks = [];
  const firstSent = sent.length;
  const firstWarning = warnings.length;
  try {
    for await (const chunk of bridge.stream({ provider: 'codex-subscription', model, messages: [...history, { role: 'user', content: [{ type: 'text', text }] }] })) chunks.push(chunk);
  } catch (error) {
    record.failure = failure(error).code;
    turns.push(record);
    return record;
  }
  const usage = chunks.find(chunk => chunk.type === 'usage')?.usage;
  const finish = chunks.find(chunk => chunk.type === 'finish');
  record.usage = usage ?? null;
  record.renderedInput = usage === undefined ? null : usage.inputTokens + (usage.cacheReadTokens ?? 0);
  record.checkpoint = finish?.replayState?.response?.[CHECKPOINT_KEY] !== undefined;
  record.chainPublished = finish?.replayState?.response?.[CONVERSATION_KEY] !== undefined;
  // The request this turn produced, matched by order rather than by content.
  const request = sent[firstSent];
  if (request !== undefined) { record.chained = request.chained; record.inputItems = request.inputItems; }
  record.warnings = warnings.slice(firstWarning);
  if (record.renderedInput !== null) spent += record.renderedInput;
  const assembler = new BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  history.push({ role: 'assistant', content: assembler.blocks(), source: { kind: 'model', provider: 'codex-subscription', model, replayState: assembler.replayState } });
  turns.push(record);
  return record;
}

try {
  const models = await bridge.listModels();
  const selected = models.find(entry => entry.id === model);
  if (selected === undefined) throw new BridgeError('MODEL_UNAVAILABLE');
  const window = selected.contextWindow;
  const percent = selected.effectivePercent;
  const limit = threshold(window, percent);
  if (limit === undefined) throw new BridgeError('INPUT_UNSUPPORTED', 'MODEL_CATALOG');
  const bound = requestLimits(window, false, percent).inputBytes;
  // The percent is recorded as null when the catalog disclosed none, so the
  // shipped fallback is distinguishable from a per-model measurement.
  console.log(JSON.stringify({ model, window, effectivePercent: percent ?? null, compactThreshold: limit, inputBytesBound: bound }));

  const calibration = await turn(prose(1200).text, 'calibration');
  if (calibration.renderedInput === null) throw new BridgeError('UPSTREAM_FAILED', 'SSE_TERMINAL');
  let bytesPerToken = calibration.bytes / calibration.renderedInput;
  const bytesPerSentence = calibration.bytes / 1200;

  for (let attempt = 0; attempt < maxTurns && spent < tokenBudget; attempt += 1) {
    // Land just above the threshold, inside the headroom the ratio leaves below
    // the window; a payload past the window is a rejection, not a compaction.
    const targetBytes = Math.min(Math.floor(limit * bytesPerToken * 1.02), Math.floor(window * bytesPerToken * 0.97), bound);
    const record = await turn(prose(Math.ceil(targetBytes / bytesPerSentence)).text, `attempt-${attempt + 1}`);
    if (record.checkpoint) break;
    // Re-estimate from the turn that just ran, so the next attempt converges.
    if (record.renderedInput) bytesPerToken = record.bytes / record.renderedInput;
  }
  if (turns.some(entry => entry.checkpoint) && spent < tokenBudget) {
    // A chained follow-up sends only what it appends, so one item is the signal
    // that the backend conversation was referenced rather than resent.
    const follow = await turn('Confirm the chain is reused.', 'follow-up');
    follow.chainConfirmed = follow.chained === true && follow.inputItems === 1;
  }
  await new Promise(resolve => setTimeout(resolve, 4000));
  console.log(JSON.stringify({ bytesPerToken: Number(bytesPerToken.toFixed(2)), spent, sent, turns }));
} catch (error) {
  await new Promise(resolve => setTimeout(resolve, 4000));
  console.log(JSON.stringify({ failure: failure(error), sent, turns }));
  process.exitCode = 1;
} finally {
  await bridge.close();
}
