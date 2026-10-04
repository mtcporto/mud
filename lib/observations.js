const COMMANDS = new Set(['score', 'spells', 'alias', 'equip', 'examine', 'help']);

export function createKnowledge() {
  return {
    score: '', scoreData: null, spells: '', spellData: [], aliases: '',
    equipment: '', equipmentItems: [], help: '', examined: {},
    examinedData: {}, updatedAt: null,
  };
}

export function commandCategory(command) {
  const match = String(command || '').trim().match(/^(score|spells|alias|equip|examine|help)(?:\s+(.+))?$/i);
  return match && { command: match[1].toLowerCase(), subject: match[2]?.trim() || '' };
}

function firstMatch(text, expression) {
  return expression.exec(text)?.[1]?.trim() || null;
}

function numberMatch(text, label) {
  const value = firstMatch(text, new RegExp(`\\b${label}\\s*:\\s*(-?\\d+)`, 'i'));
  return value === null ? null : Number(value);
}

export function parseScore(text) {
  const score = {};
  const name = firstMatch(text, /\bName\s*:\s*(.*?)\s+Level\s*:/i);
  if (name) score.name = name;
  for (const [key, label] of [['race', 'Race'], ['class', 'Class'], ['sex', 'Sex'], ['position', 'Position']]) {
    const value = firstMatch(text, new RegExp(`\\b${label}\\s*:\\s*(.*?)(?=\\s{2,}[A-Z][A-Za-z ]*\\s*:|\\s*\\||\\r?$)`, 'im'));
    if (value) score[key] = value;
  }
  const level = firstMatch(text, /\bLevel\s*:\s*(\d+)/i);
  if (level) score.level = Number(level);
  const age = firstMatch(text, /\bAge\s*:\s*(\d+)\s+years?/i);
  if (age) score.ageYears = Number(age);
  const played = firstMatch(text, /\bPlayed\s*:\s*(\d+)\s+hours?/i);
  if (played) score.playedHours = Number(played);

  score.attributes = {};
  for (const match of text.matchAll(/\b(Str|Int|Wis|Dex|Con)\s*:\s*(\d+)(?:\s*\((\d+)\))?/gi)) {
    score.attributes[match[1].toLowerCase()] = { base: Number(match[2]), modified: Number(match[3] || match[2]) };
  }
  score.resources = {};
  for (const match of text.matchAll(/\b(Hit|Mana|Move)\s*:\s*(\d+)\s*\/\s*(\d+)/gi)) {
    score.resources[match[1].toLowerCase()] = { current: Number(match[2]), maximum: Number(match[3]) };
  }
  score.armor = {};
  for (const match of text.matchAll(/\b(Piercing|Bashing|Slashing|Exotic)\s*:\s*(-?\d+)/gi)) {
    score.armor[match[1].toLowerCase()] = Number(match[2]);
  }
  for (const label of ['Experience', 'Next level', 'Questpoints', 'Practices', 'Training', 'Wimpy', 'Carrying', 'Weight', 'Hitroll', 'Damroll', 'Gold', 'Silver', 'Alignment']) {
    const value = numberMatch(text, label.replace(' ', '\\s+'));
    if (value !== null) score[label.toLowerCase().replaceAll(' ', '_')] = value;
  }
  for (const label of ['Hunger', 'Thirst', 'Adrenaline', 'Drunk']) {
    const value = firstMatch(text, new RegExp(`\\b${label}\\s*:\\s*([^\\s|]+)`, 'i'));
    if (value) score[label.toLowerCase()] = value;
  }
  const explored = firstMatch(text, /\bExplored\s*:\s*(\d+%)/i);
  if (explored) score.explored = explored;
  return score;
}

export function parseEquipment(text) {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*<([^>]+)>\s*(.*)$/);
    if (!match) continue;
    const flags = [...match[2].matchAll(/\(([^)]+)\)/g)].map(flag => flag[1].trim());
    const name = match[2].replace(/\([^)]*\)/g, '').trim();
    if (name && name !== '-') items.push({ slot: match[1].trim(), name, flags });
  }
  return items;
}

export function parseExamine(text) {
  const objectName = firstMatch(text, /\bobject\s+'([^']+)'/i);
  const description = firstMatch(text, /\bobject\s+'[^']+'\s+is\s+([^\r\n]+)/i);
  const armorText = firstMatch(text, /Armor class is\s+([^\r\n]+)/i);
  const armor = {};
  if (armorText) {
    for (const match of armorText.matchAll(/(-?\d+)\s+(pierce|bash|slash|(?:vs\.\s*)?magic)/gi)) {
      armor[match[2].replace(/^vs\.\s*/i, '').toLowerCase()] = Number(match[1]);
    }
  }
  const affects = [];
  for (const match of text.matchAll(/\bAffects\s+(.+?)\s+by\s+(-?\d+)\./gi)) {
    if (!/^none$/i.test(match[1].trim())) affects.push({ attribute: match[1].trim().toLowerCase(), amount: Number(match[2]) });
  }
  const immunities = [...text.matchAll(/\bAdds immunity to ([^.]+)\./gi)].map(match => match[1].trim().toLowerCase());
  const value = firstMatch(text, /\bvalue is\s+(-?\d+)/i);
  const level = firstMatch(text, /\blevel is\s+(\d+)/i);
  const flags = firstMatch(text, /\bextra flags\s+([^\r\n.]+)/i);
  const slot = firstMatch(text, /\bobject\s+'[^']+'\s+is\s+\w+\s+for\s+([^\r\n.]+)/i);
  return {
    objectName, description, slot,
    value: value === null ? null : Number(value),
    level: level === null ? null : Number(level),
    flags: flags ? flags.split(/\s+/).filter(Boolean) : [],
    armor, affects, immunities,
  };
}

export function parseSpells(text) {
  const spells = [];
  const pattern = /([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*)*?)\s+(\d{1,3})%\s+\(\s*\d{1,3}%\s*\)\s+(\d+)ma\b/gi;
  for (const match of text.matchAll(pattern)) {
    const name = match[1].trim().replace(/^\d+\s*:\s*/, '');
    spells.push({ name, proficiency: Number(match[2]), mana: Number(match[3]) });
  }
  return spells;
}

export function parseObservation(command, text) {
  const category = commandCategory(command);
  if (!category || !COMMANDS.has(category.command) || !String(text || '').trim()) return null;
  const raw = String(text).slice(-12000);
  let data = null;
  if (category.command === 'score') data = parseScore(raw);
  else if (category.command === 'equip') data = parseEquipment(raw);
  else if (category.command === 'examine') data = parseExamine(raw);
  else if (category.command === 'spells') data = parseSpells(raw);
  return { ...category, raw, data, updatedAt: new Date().toISOString() };
}

export function observe(knowledge, command, text) {
  const observation = parseObservation(command, text);
  if (!observation) return knowledge;
  if (observation.command === 'examine') {
    const subject = observation.subject || observation.data.objectName || 'unknown';
    knowledge.examined[subject] = observation.raw;
    knowledge.examinedData[subject] = observation.data;
  } else {
    const key = observation.command === 'alias' ? 'aliases' : observation.command;
    knowledge[key] = observation.raw;
    if (observation.command === 'score') knowledge.scoreData = observation.data;
    if (observation.command === 'equip') knowledge.equipmentItems = observation.data;
    if (observation.command === 'spells') knowledge.spellData = observation.data;
  }
  knowledge.updatedAt = observation.updatedAt;
  return knowledge;
}

export function publicKnowledge(knowledge) {
  return {
    ...knowledge,
    scoreData: knowledge.scoreData ? structuredClone(knowledge.scoreData) : null,
    spellData: [...knowledge.spellData],
    equipmentItems: knowledge.equipmentItems.map(item => ({ ...item, flags: [...item.flags] })),
    examined: { ...knowledge.examined },
    examinedData: structuredClone(knowledge.examinedData),
  };
}

export const trackedCommands = [...COMMANDS];
