import { BridgeError } from './errors.js';
import { digest, contentDigest } from './hashes.js';
import { measure, fits } from './text.js';

export const CONVERSATION_KEY = 'subscriptionConversationV1';
export const CONVERSATION_MAX_AGE = 24 * 60 * 60 * 1000;
export const CONVERSATION_ID_MAX = 256;

// The same binding the window used: a chain is only valid for the account, model,
// developer instructions and tool definitions it was established under.
export function conversationScope(account, model, plan) {
  return digest([account, model, plan.tools ?? [], plan.input.filter(value => value.type === 'message' && value.role === 'developer')]);
}

const fail = reason => { const error = new BridgeError('PROTOCOL_INVALID', 'CONVERSATION'); error.stage = reason; throw error; };
const stage = error => (error instanceof BridgeError && typeof error.stage === 'string' ? error.stage : 'UNKNOWN');
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && Buffer.byteLength(value) <= max;

/**
 * Find the newest conversation record and prove the transcript is exactly the input
 * that record was established on, plus the assistant answer it describes.
 *
 * The bridge can prove what it sent. It cannot prove what the backend still holds,
 * so a divergence is refused rather than trusted and the turn falls back to sending
 * the full history under the ordinary bounds. The record stores no opaque content:
 * in a stateful turn nothing is replayed, so nothing opaque passes through the bridge.
 */
export function inspectConversation(messages, plan, scope, now = Date.now()) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const candidate = messages[index].source?.replayState?.response?.[CONVERSATION_KEY];
    if (!candidate) continue;
    try {
      if (messages[index].role !== 'assistant') return { refusal: 'SHAPE' };
      if (candidate.version !== 1 || !Number.isSafeInteger(candidate.createdAt) || candidate.createdAt > now) return { refusal: 'METADATA' };
      if (now - candidate.createdAt > CONVERSATION_MAX_AGE) return { refusal: 'EXPIRED' };
      if (candidate.scope !== scope) return { refusal: 'SCOPE' };
      if (!text(candidate.id, CONVERSATION_ID_MAX)) return { refusal: 'ID' };
      const span = plan.spans[index];
      if (candidate.sent !== digest(plan.input.slice(0, span.start))) return { refusal: 'PREFIX' };
      if (candidate.content !== contentDigest(messages[index].content)) return { refusal: 'CONTENT' };
      return { id: candidate.id, end: span.end, imageEnd: span.imageEnd };
    } catch (error) { return { refusal: stage(error) === 'UNKNOWN' ? 'INVALID' : stage(error) }; }
  }
  return {};
}

/**
 * The items a chained turn sends: everything after what the record covers.
 *
 * The backend holds the covered part, so the bridge cannot bound it. Only the
 * appended items are bounded here, and a transcript whose new part exceeds the
 * wire bounds is refused rather than sent oversized.
 */
export function appendedItems(plan, conversation, limits) {
  const input = plan.input.slice(conversation.end);
  const measured = measure(input);
  if (!fits(limits, input, measured)) throw new BridgeError('INPUT_UNSUPPORTED', 'CONVERSATION');
  return { input, attachments: measured.attachments };
}

/** Publish the record for the next turn. The response id is validated, never logged. */
export function conversationRecord(scope, id, sent, content, now = Date.now()) {
  if (!text(id, CONVERSATION_ID_MAX)) return { refusal: 'ID' };
  return { response: { [CONVERSATION_KEY]: { version: 1, createdAt: now, scope, id, sent, content } } };
}
