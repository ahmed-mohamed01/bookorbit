const CLOSER: Record<string, string> = { '{': '}', '[': ']' };

/**
 * Mends the bracket slips a small model makes after a long run of numbers: a closer that does not match
 * the open bracket becomes the one that does, and closers left off the end are added. Text inside strings
 * is left alone; an unterminated string is closed first.
 */
export function repairJson(text: string): string {
  const start = text.search(/[{[]/);
  if (start < 0) return text;
  const stack: string[] = [];
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of text.slice(start)) {
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(CLOSER[char]);
    else if (char === '}' || char === ']') {
      if (!stack.length) break;
      out += stack.pop();
      if (!stack.length) return out;
      continue;
    }
    out += char;
  }
  if (inString) out += '"';
  return out + stack.reverse().join('');
}
