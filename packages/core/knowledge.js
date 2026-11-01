// File-based knowledge base. The file is read on every call, so edits apply to
// the next call without a restart.
//
// The Realtime API rejects instructions above ~16k tokens — the model then runs
// WITHOUT instructions and improvises. Keep the knowledge part under a hard
// character cap (~3 characters per token for most European languages).
const fs = require('fs');

const DEFAULT_MAX_CHARS = 45000;

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    console.error('[KNOWLEDGE] cannot read', file, e.message);
    return '';
  }
}

// Strip markdown emphasis and collapse whitespace — the model reads it, nobody sees it.
function compact(text) {
  return text.replace(/\*\*/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function fileKnowledge(file, { maxChars = DEFAULT_MAX_CHARS, title = 'KNOWLEDGE BASE' } = {}) {
  return function knowledge(reserved = 0) {
    let text = compact(readSafe(file));
    const room = maxChars - reserved;
    if (text.length > room) {
      console.error(`[KNOWLEDGE] ${file} (${text.length} chars) exceeds the instruction budget — truncated to ${room}. Shorten the file.`);
      text = text.slice(0, Math.max(room, 0));
    }
    return `=== ${title} ===\n${text || '(knowledge base unavailable — be careful with specific facts and hand over to a colleague)'}`;
  };
}

module.exports = { fileKnowledge, compact, DEFAULT_MAX_CHARS };
