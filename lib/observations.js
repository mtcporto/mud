const COMMANDS = new Set(['score', 'spells', 'effect', 'alias', 'equip', 'examine', 'help', 'creation', 'map', 'look', 'practice']);
const CREATION_OPTION_CATEGORIES = new Map([
  ...['human', 'elf', 'dwarf', 'giant', 'halfling', 'kender', 'drow'].map(name => [name, 'race']),
  ...['mage', 'cleric', 'thief', 'warrior'].map(name => [name, 'base_class']),
  ...['male', 'female'].map(name => [name, 'sex']),
  ...['good', 'neutral', 'evil'].map(name => [name, 'alignment']),
  ...['sword', 'mace', 'dagger', 'axe', 'staff', 'flail', 'whip', 'polearm'].map(name => [name, 'weapon']),
  ['ansi color', 'option'],
]);

export function createKnowledge() {
  return {
    score: '', scoreData: null, spells: '', spellData: [], effect: '', activeEffects: [], map: '', mapData: null,
    rooms: {}, aliases: '',
    equipment: '', equipmentItems: [], help: '', examined: {},
    examinedData: {}, updatedAt: null,
  };
}

export function commandCategory(command) {
  const value = String(command || '').trim();
  if (/^(?:look\s+)?map$/i.test(value)) {
    return { command: 'map', subject: 'midgaard' };
  }
  const match = value.match(/^(score|spells|affects?|effects?|alias|equip(?:ment)?|examine|help|creation|look|practice)(?:\s+(.+))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (name === 'look' && match[2]) return null;
  return {
    command: /^(?:affects?|effects?)$/.test(name) ? 'effect' : name === 'equipment' ? 'equip' : name,
    subject: match[2]?.trim() || '',
  };
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
  const armorPattern = /\b(Piercing|Bashing|Slashing|Exotic)\s*:\s*([^|\r\n]+?)(?=\s{2,}[A-Z][A-Za-z ]*\s*:|\s*\||$)/gim;
  for (const match of text.matchAll(armorPattern)) {
    const value = match[2].trim();
    score.armor[match[1].toLowerCase()] = /^-?\d+$/.test(value) ? Number(value) : value;
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

export function parseExamine(text, fallbackName = '') {
  const source = String(text || '');
  if (/\b(?:you do not see|you don't see|you cannot see|you can't see|you see no|no such (?:item|object))\b/i.test(source)) return null;
  let objectName = firstMatch(source, /\bobject\s+'([^']+)'/i);
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
  const hasItemDetails = /\b(?:object\s+'[^']+'\s+is|your expertise reveals|value is\s+-?\d+|level is\s+\d+|extra flags\b|armor class is\b|affects\b|adds immunity to\b|you see\b)/i.test(source);
  if (!objectName && fallbackName && hasItemDetails) objectName = fallbackName.trim();
  if (!objectName || !hasItemDetails) return null;
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

export function parsePractices(text) {
  const source = String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const report = source.match(/\bYou have\s+(\d+)\s+practice sessions? left\./i);
  const action = source.match(/\bis now at\s+(\d{1,3})\s+percent\b[^\r\n]*?(\d+)\s+practices left/i);
  const skills = [];
  const pattern = /([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*?)*)\s+(\d{1,3})%\s+\(\s*(\d{1,3})%\s*\)/gi;
  for (const match of source.matchAll(pattern)) {
    skills.push({
      name: match[1].trim().toLowerCase(),
      proficiency: Number(match[2]),
      baseProficiency: Number(match[3]),
    });
  }
  if (action) {
    const skillMatch = source.match(/\b([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*?)*)\s+is now at\s+\d{1,3}\s+percent\b/i);
    if (skillMatch) skills.push({
      name: skillMatch[1].trim().toLowerCase(),
      proficiency: Number(action[1]),
      baseProficiency: Number(action[1]),
    });
  }
  const remaining = report ? Number(report[1]) : action ? Number(action[2]) : null;
  return skills.length || remaining !== null
    ? { remaining, complete: Boolean(report), skills }
    : null;
}

export function parseEffects(text) {
  const effects = [];
  const source = String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n');
  for (const match of source.matchAll(/(?:Spell:\s*)?['"]?(.+?)['"]?\s+(?:modifies|affects)\s+(.+?)\s+by\s+(-?\d+)(?:\s+for\s+([^.]+))?\.?(?=\s|$)/gi)) {
    effects.push({
      name: match[1].trim().replace(/^['"]|['"]$/g, '').trim(),
      attribute: match[2].trim().toLowerCase(),
      amount: Number(match[3]),
      duration: match[4]?.trim() || null,
    });
  }
  for (const match of source.matchAll(/(?:^|\s)-\s+([^-\r\n]+?)(?=\s+-\s+|[\r\n]|$)/g)) {
    const name = match[1].trim();
    if (name && !/^none$/i.test(name) && !effects.some(effect => effect.name.toLowerCase() === name.toLowerCase())) {
      effects.push({ name, attribute: null, amount: null, duration: null });
    }
  }
  return effects;
}

export function parseMap(text) {
  const rows = String(text || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter(line => line.trim());
  return rows.length ? { area: 'midgaard', rows } : null;
}

export function parseRoom(text) {
  const source = String(text || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
  const lines = source.split('\n');
  const promptIndex = lines.findIndex(line => /\|\s*[NSEWUD]+\s*>\s*$/i.test(line));
  const content = promptIndex < 0 ? lines : lines.slice(0, promptIndex);
  const titleIndex = content.findIndex(line => {
    const value = line.trim();
    return value
      && !/^>/.test(value)
      && !/^\d+\/\d+hp\b/i.test(value)
      && !/^You\b/i.test(value)
      && !/^Obvious exits:/i.test(value)
      && !/^The .+\b(?:says|tells|utters)\b/i.test(value);
  });
  if (titleIndex < 0) return null;
  const name = content[titleIndex].trim();
  const description = content.slice(titleIndex + 1).join('\n').trim();
  if (!description) return null;
  const exitsText = promptIndex < 0 ? '' : lines[promptIndex].match(/\|\s*([NSEWUD]+)\s*>\s*$/i)?.[1] || '';
  const visibleEntities = content.slice(titleIndex + 1)
    .map(line => line.trim())
    .filter(line => /^(?:.+?)\s+(?:is|are) here\.$/i.test(line));
  return {
    name,
    description,
    exits: [...new Set(exitsText.toUpperCase())],
    visibleEntities,
  };
}

function roomSubject(room) {
  const entities = new Set(room.visibleEntities.map(entity => entity.toLowerCase()));
  const description = room.description.split('\n')
    .filter(line => !entities.has(line.trim().toLowerCase()))
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const identity = `${description}|${room.exits.join('')}`;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
  }
  return `${room.name.toLowerCase()}#${(hash >>> 0).toString(36)}`;
}

function selectionState(marker) {
  if (marker === 'X') return 'selected';
  if (marker === 'x') return 'inherited';
  if (marker === '*') return 'fixed';
  return 'available';
}

export function parseCharacterCreation(text) {
  const source = String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  const header = source.match(/\bCharacter\s*:\s*(.+?)\s+Creation Points\s*:\s*(\d+)\s+XP per level\s*:\s*(\d+)/i);
  if (!header) return null;

  const result = {
    characterName: header[1].trim(),
    creationPoints: Number(header[2]),
    experiencePerLevel: Number(header[3]),
    selections: { race: null, baseClass: null, sex: null, alignment: null, weapon: null, ansiColor: false },
    options: [],
    groups: [],
    skills: [],
    experienceCurve: [],
  };
  const lines = source.split('\n');
  const optionHeader = lines.findIndex(line => /\bRace\s+Base Class\s+Sex\s+Weapons\s+Options\b/i.test(line));
  if (optionHeader >= 0) {
    const options = new Map();
    for (const line of lines.slice(optionHeader + 1)) {
      if (/^\s*Commands:/i.test(line)) break;
      for (const match of line.matchAll(/\[\s*([Xx*]?)\s*\]\s+([a-z][a-z ]*?)(?=\s+\[\s*[Xx*]?\s*\]\s+|$)/gi)) {
        const displayName = match[2].trim().replace(/\s+Alignment$/i, '');
        const name = displayName.toLowerCase().replace(/\s+/g, ' ');
        const category = CREATION_OPTION_CATEGORIES.get(name);
        if (!category) continue;
        const key = `${category}:${name}`;
        if (!options.has(key)) {
          options.set(key, {
            category,
            name,
            displayName,
            state: selectionState(match[1]),
            sortOrder: [...options.values()].filter(option => option.category === category).length,
          });
        } else {
          options.get(key).state = selectionState(match[1]);
        }
      }
    }
    result.options = [...options.values()];
    for (const option of result.options) {
      if (!['selected', 'inherited', 'fixed'].includes(option.state)) continue;
      if (option.category === 'option') result.selections.ansiColor = true;
      else {
        const key = option.category === 'base_class' ? 'baseClass' : option.category;
        result.selections[key] = option.name;
      }
    }
  }

  let skillHeader = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/Groups\s+Skills\s+Skills/i.test(lines[index])) {
      skillHeader = index;
      break;
    }
  }
  if (skillHeader >= 0) {
    const headerLine = lines[skillHeader];
    const firstSkillColumn = headerLine.indexOf('Skills');
    const secondSkillColumn = headerLine.lastIndexOf('Skills');
    const firstBoundary = Math.floor(firstSkillColumn / 2);
    const secondBoundary = Math.floor((firstSkillColumn + secondSkillColumn) / 2);
    const groups = new Map();
    const skills = new Map();
    for (const line of lines.slice(skillHeader + 1)) {
      if (/^\s*Commands:/i.test(line)) continue;
      for (const match of line.matchAll(/\[\s*([Xx*]?)\s*\]\s*(\d+)\s+([a-z][a-z ]*?)(?=\s+\[\s*[Xx*]?\s*\]\s*\d+\s+|$)/gi)) {
        const entryType = match.index < firstBoundary ? 'group' : 'skill';
        const name = match[3].trim().toLowerCase().replace(/\s+/g, ' ');
        const entry = {
          name,
          cost: Number(match[2]),
          state: selectionState(match[1]),
        };
        (entryType === 'group' ? groups : skills).set(name, entry);
      }
    }
    result.groups = [...groups.values()];
    result.skills = [...skills.values()];
  }

  const curveHeader = lines.findIndex(line => /\bpoints\s+exp\/level\b/i.test(line));
  if (curveHeader >= 0) {
    for (const line of lines.slice(curveHeader + 1)) {
      const values = line.trim().match(/^\d+(?:\s+\d+)+$/)?.[0].match(/\d+/g)?.map(Number);
      if (!values) {
        if (result.experienceCurve.length && line.trim()) break;
        continue;
      }
      for (let index = 0; index + 1 < values.length; index += 2) {
        result.experienceCurve.push({ creationPoints: values[index], experiencePerLevel: values[index + 1] });
      }
    }
  }
  return result;
}

export function parseObservation(command, text) {
  const category = commandCategory(command);
  if (!category || !COMMANDS.has(category.command) || !String(text || '').trim()) return null;
  const source = String(text).slice(-12000);
  let data = null;
  if (category.command === 'score') data = parseScore(source);
  else if (category.command === 'equip') data = parseEquipment(source);
  else if (category.command === 'examine') {
    data = parseExamine(source, category.subject);
    if (!data) return null;
  }
  else if (category.command === 'spells') data = parseSpells(source);
  else if (category.command === 'practice') {
    data = parsePractices(source);
    if (!data) return null;
  }
  else if (category.command === 'effect') data = parseEffects(source);
  else if (category.command === 'map') {
    data = parseMap(source);
    if (!data) return null;
  }
  else if (category.command === 'look') {
    data = parseRoom(source);
    if (!data) return null;
  }
  else if (category.command === 'creation') {
    data = parseCharacterCreation(source);
    if (!data) return null;
  }
  const raw = category.command === 'creation' ? JSON.stringify(data) : source;
  return {
    ...category,
    subject: category.command === 'look' ? roomSubject(data) : category.subject,
    raw,
    data,
    updatedAt: new Date().toISOString(),
  };
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
    if (observation.command === 'effect') knowledge.activeEffects = observation.data;
    if (observation.command === 'map') knowledge.mapData = observation.data;
    if (observation.command === 'look') knowledge.rooms[observation.subject] = observation.data;
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
