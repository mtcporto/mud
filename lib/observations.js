const COMMANDS = new Set(['score', 'spells', 'alias', 'equip', 'examine']);

export function createKnowledge() {
  return { score: '', spells: '', aliases: '', equipment: '', examined: {}, updatedAt: null };
}

export function commandCategory(command) {
  const match = String(command || '').trim().match(/^(score|spells|alias|equip|examine)(?:\s+(.+))?$/i);
  return match && { command: match[1].toLowerCase(), subject: match[2]?.trim() || '' };
}

export function observe(knowledge, command, text) {
  const category = commandCategory(command);
  if (!category || !text?.trim()) return knowledge;
  const value = text.slice(-12000);
  if (category.command === 'examine') knowledge.examined[category.subject || 'unknown'] = value;
  else knowledge[category.command] = value;
  knowledge.updatedAt = new Date().toISOString();
  return knowledge;
}

export function publicKnowledge(knowledge) {
  return { ...knowledge, examined: { ...knowledge.examined } };
}

export const trackedCommands = [...COMMANDS];
