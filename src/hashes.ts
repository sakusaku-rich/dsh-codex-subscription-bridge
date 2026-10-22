import { createHash } from 'node:crypto';

/** A content block as the bridge projects it for hashing. */
export interface HashableBlock {
  type: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const contentDigest = (blocks: readonly HashableBlock[]): string => digest(blocks.filter(block => block.type === 'text' || block.type === 'tool-call')
  .map(block => block.type === 'text' ? { type: 'text', text: block.text } : { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }));
