import {setImmediate as yieldLoop} from 'node:timers/promises';
import {BridgeError,classified,object} from './errors.js';
export const FRAME_LIMIT = 1024 * 1024;
const TOTAL_LIMIT = 4 * FRAME_LIMIT;
const EVENT_LIMIT = 4096;
/** Resolve one caller-raised framing bound; only raising above the default is valid. */
function resolveLimit(value, floor) {
  if (value === undefined) return floor;
  // A misapplied bound is a programming error: fail loudly here, outside the
  // stream reader, instead of disguising it as a mid-stream protocol failure.
  if (!Number.isSafeInteger(value) || value < floor) throw new Error(`SSE framing limits must be safe integers at or above ${floor}.`);
  return value;
}
/**
 * Incremental byte framing: each byte is scanned once, with bounded work batches.
 *
 * The default bounds frame an ordinary stream. A caller whose stream admits
 * larger opaque content — one compaction item travelling inside a single event
 * frame — raises `limits.frameLimit` and `limits.totalLimit` for that stream;
 * only raising above the defaults is valid and the event count stays fixed.
 */
export async function* events(body, signal, track = promise => promise, limits) {
  if (!body) throw new BridgeError('PROTOCOL_INVALID', 'SSE_FRAME');
  const frameLimit = resolveLimit(limits?.frameLimit, FRAME_LIMIT);
  const totalLimit = resolveLimit(limits?.totalLimit, TOTAL_LIMIT);
  if (signal.aborted) { await track(body.cancel().catch(() => {})); throw new BridgeError('ABORTED'); }
  const reader = body.getReader();
  const cancel = () => { void track(reader.cancel().catch(() => {}).then(() => { reader.releaseLock(); }).catch(() => {})); };
  signal.addEventListener('abort', cancel, {once:true});
  const frame = Buffer.allocUnsafe(frameLimit + 4);
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let used=0, lineLength=0, previousByte=-1, previousEnd=0, total=0, count=0, byteWork=0, readWork=0;
  const checkAbort = () => { if (signal.aborted) throw new BridgeError('ABORTED'); };
  try {
    for (;;) {
      checkAbort();
      if (++readWork >= 256) { readWork=0; await yieldLoop(); checkAbort(); }
      const part=await reader.read();
      if (part.done) break;
      total+=part.value.byteLength;
      if (total>totalLimit) throw new BridgeError('LIMIT_EXCEEDED');
      for (const byte of part.value) {
        if (++byteWork >= 4096) { byteWork=0; await yieldLoop(); checkAbort(); }
        if (used>=frame.length) throw new BridgeError('LIMIT_EXCEEDED');
        frame[used++]=byte;
        // Up to four delimiter bytes may follow a full-sized frame.
        if (used>frameLimit && byte!==10 && byte!==13) throw new BridgeError('LIMIT_EXCEEDED');
        if (byte===10) {
          const endLength=previousByte===13?2:1;
          const empty=lineLength===0 || (lineLength===1 && previousByte===13);
          if (empty && previousEnd) {
            const payloadLength=used-previousEnd-endLength;
            if (payloadLength>frameLimit || ++count>EVENT_LIMIT) throw new BridgeError('LIMIT_EXCEEDED');
            const text=decoder.decode(frame.subarray(0,payloadLength));
            const data=text.split(/\r?\n/u).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /u,'')).join('\n');
            used=0;lineLength=0;previousByte=-1;previousEnd=0;
            if (data && data!=='[DONE]') {
              let value;try{value=object(JSON.parse(data));}catch{throw new BridgeError('PROTOCOL_INVALID','SSE_FRAME');}
              checkAbort();yield value;
            }
            continue;
          }
          lineLength=0;previousEnd=endLength;
        } else lineLength++;
        previousByte=byte;
      }
    }
    checkAbort();
    if (used && decoder.decode(frame.subarray(0,used)).trim()) throw new BridgeError('PROTOCOL_INVALID','SSE_FRAME');
  } catch(error) {
    if (error instanceof BridgeError) throw classified(error,'SSE_FRAME');
    throw new BridgeError(signal.aborted?'ABORTED':'PROTOCOL_INVALID','SSE_FRAME');
  } finally { signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock(); }
}
