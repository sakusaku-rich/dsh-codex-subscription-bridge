import {setImmediate as yieldLoop} from 'node:timers/promises';
import {BridgeError,classified,object} from './errors.js';
const FRAME_LIMIT = 1024 * 1024;
/** Incremental byte framing: each byte is scanned once, with bounded work batches. */
export async function* events(body, signal, track = promise => promise) {
  if (!body) throw new BridgeError('PROTOCOL_INVALID', 'SSE_FRAME');
  if (signal.aborted) { await track(body.cancel().catch(() => {})); throw new BridgeError('ABORTED'); }
  const reader = body.getReader();
  const cancel = () => { void track(reader.cancel().catch(() => {}).then(() => { reader.releaseLock(); }).catch(() => {})); };
  signal.addEventListener('abort', cancel, {once:true});
  const frame = Buffer.allocUnsafe(FRAME_LIMIT + 4);
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
      if (total>4*FRAME_LIMIT) throw new BridgeError('LIMIT_EXCEEDED');
      for (const byte of part.value) {
        if (++byteWork >= 4096) { byteWork=0; await yieldLoop(); checkAbort(); }
        if (used>=frame.length) throw new BridgeError('LIMIT_EXCEEDED');
        frame[used++]=byte;
        // Up to four delimiter bytes may follow a full-sized frame.
        if (used>FRAME_LIMIT && byte!==10 && byte!==13) throw new BridgeError('LIMIT_EXCEEDED');
        if (byte===10) {
          const endLength=previousByte===13?2:1;
          const empty=lineLength===0 || (lineLength===1 && previousByte===13);
          if (empty && previousEnd) {
            const payloadLength=used-previousEnd-endLength;
            if (payloadLength>FRAME_LIMIT || ++count>4096) throw new BridgeError('LIMIT_EXCEEDED');
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
