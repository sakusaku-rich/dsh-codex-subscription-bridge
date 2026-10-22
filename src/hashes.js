import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const contentDigest = blocks => digest(blocks.filter(block => block.type === 'text' || block.type === 'tool-call')
  .map(block => block.type === 'text' ? { type: 'text', text: block.text } : { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }));
