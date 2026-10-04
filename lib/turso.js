import { createClient } from '@libsql/client/web';
import { parseObservation } from './observations.js';
import { isProfileId } from './profile.js';
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mud_profiles (
    profile_id TEXT PRIMARY KEY,
    character_name TEXT,
    score_json TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mud_observations (
    profile_id TEXT NOT NULL,
    command TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    raw_text TEXT NOT NULL,
    data_json TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, command, subject)
  )`,
  `CREATE TABLE IF NOT EXISTS mud_equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    item_name TEXT NOT NULL,
    flags_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS mud_equipment_profile_idx ON mud_equipment(profile_id)',
  `CREATE TABLE IF NOT EXISTS mud_items (
    profile_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    item_name TEXT NOT NULL,
    subject TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, item_key)
  )`,
  `CREATE TABLE IF NOT EXISTS mud_spells (
    profile_id TEXT NOT NULL,
    spell_name TEXT NOT NULL,
    proficiency INTEGER NOT NULL,
    mana INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, spell_name)
  )`,
];

export function normalizeItemKey(name) {
  return String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter(Boolean).map(word => word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)
    .sort().join(' ');
}

export function summarizeEquipment(equipment, items) {
  const details = new Map(items.map(item => [normalizeItemKey(item.name), item]));
  const equipped = equipment.map(item => ({
    ...item,
    examined: details.get(normalizeItemKey(item.name))?.data || null,
  }));
  const modifiers = new Map();
  const immunities = new Set();
  for (const item of equipped) {
    if (!item.examined) continue;
    for (const affect of item.examined.affects || []) {
      modifiers.set(affect.attribute, (modifiers.get(affect.attribute) || 0) + affect.amount);
    }
    for (const immunity of item.examined.immunities || []) immunities.add(immunity);
  }
  return {
    equipped,
    unexamined: equipped.filter(item => !item.examined).map(({ slot, name }) => ({ slot, name })),
    knownModifiers: Object.fromEntries([...modifiers].sort(([left], [right]) => left.localeCompare(right))),
    knownImmunities: [...immunities].sort(),
    caveat: 'Soma apenas efeitos extraídos de itens equipados e examinados; regras de acúmulo do jogo podem alterar o total efetivo.',
  };
}

export class TursoKnowledgeStore {
  constructor({ url, authToken, clientFactory = createClient }) {
    this.url = url;
    this.authToken = authToken;
    this.clientFactory = clientFactory;
    this.client = null;
    this.schemaReady = null;
  }

  async database() {
    if (!this.url || !this.authToken) throw new Error('Turso is not configured.');
    if (!this.client) this.client = this.clientFactory({ url: this.url, authToken: this.authToken });
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        for (const sql of SCHEMA) await this.client.execute(sql);
      })();
    }
    try {
      await this.schemaReady;
    } catch (error) {
      this.schemaReady = null;
      throw error;
    }
    return this.client;
  }

  async save(profileId, command, text) {
    if (!isProfileId(profileId)) throw new Error('Invalid profile ID.');
    const observation = parseObservation(command, text);
    if (!observation) return false;
    const db = await this.database();
    const { command: category, subject, raw, data, updatedAt } = observation;
    const statements = [{
      sql: `INSERT INTO mud_profiles(profile_id, updated_at) VALUES (?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET updated_at = excluded.updated_at`,
      args: [profileId, updatedAt],
    }, {
      sql: `INSERT INTO mud_observations(profile_id, command, subject, raw_text, data_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, command, subject) DO UPDATE SET
          raw_text = excluded.raw_text, data_json = excluded.data_json, updated_at = excluded.updated_at`,
      args: [profileId, category, subject, raw, data === null ? null : JSON.stringify(data), updatedAt],
    }];

    if (category === 'score' && data.name) statements.push({
      sql: `UPDATE mud_profiles SET character_name = ?, score_json = ?, updated_at = ?
        WHERE profile_id = ?`,
      args: [data.name, JSON.stringify(data), updatedAt, profileId],
    });
    if (category === 'equip') {
      statements.push({ sql: 'DELETE FROM mud_equipment WHERE profile_id = ?', args: [profileId] });
      for (const item of data) statements.push({
        sql: 'INSERT INTO mud_equipment(profile_id, slot, item_name, flags_json, updated_at) VALUES (?, ?, ?, ?, ?)',
        args: [profileId, item.slot, item.name, JSON.stringify(item.flags), updatedAt],
      });
    }
    if (category === 'examine') {
      const name = data.objectName || subject || 'unknown';
      statements.push({
        sql: `INSERT INTO mud_items(profile_id, item_key, item_name, subject, raw_text, data_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_id, item_key) DO UPDATE SET
            item_name = excluded.item_name, subject = excluded.subject, raw_text = excluded.raw_text,
            data_json = excluded.data_json, updated_at = excluded.updated_at`,
        args: [profileId, normalizeItemKey(name), name, subject, raw, JSON.stringify(data), updatedAt],
      });
    }
    if (category === 'spells') {
      statements.push({ sql: 'DELETE FROM mud_spells WHERE profile_id = ?', args: [profileId] });
      for (const spell of data) statements.push({
        sql: `INSERT INTO mud_spells(profile_id, spell_name, proficiency, mana, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
        args: [profileId, spell.name, spell.proficiency, spell.mana, updatedAt],
      });
    }
    await db.batch(statements, 'write');
    return true;
  }

  async get(profileId) {
    if (!isProfileId(profileId)) throw new Error('Invalid profile ID.');
    const db = await this.database();
    const [profileResult, observationResult, equipmentResult, itemResult, spellResult] = await Promise.all([
      db.execute({ sql: 'SELECT character_name, score_json, updated_at FROM mud_profiles WHERE profile_id = ?', args: [profileId] }),
      db.execute({ sql: 'SELECT command, subject, raw_text, data_json, updated_at FROM mud_observations WHERE profile_id = ? ORDER BY command, subject', args: [profileId] }),
      db.execute({ sql: 'SELECT slot, item_name, flags_json, updated_at FROM mud_equipment WHERE profile_id = ? ORDER BY slot', args: [profileId] }),
      db.execute({ sql: 'SELECT item_name, subject, raw_text, data_json, updated_at FROM mud_items WHERE profile_id = ? ORDER BY item_name', args: [profileId] }),
      db.execute({ sql: 'SELECT spell_name, proficiency, mana, updated_at FROM mud_spells WHERE profile_id = ? ORDER BY spell_name', args: [profileId] }),
    ]);
    const observations = observationResult.rows.map(row => ({
      command: row.command, subject: row.subject, raw: row.raw_text,
      data: row.data_json === null ? null : JSON.parse(row.data_json), updatedAt: row.updated_at,
    }));
    const profile = profileResult.rows[0];
    const equipment = equipmentResult.rows.map(row => ({
      slot: row.slot, name: row.item_name, flags: JSON.parse(row.flags_json), updatedAt: row.updated_at,
    }));
    const items = itemResult.rows.map(row => ({
      name: row.item_name, subject: row.subject, raw: row.raw_text,
      data: JSON.parse(row.data_json), updatedAt: row.updated_at,
    }));
    return {
      profile: profile ? {
        characterName: profile.character_name,
        score: profile.score_json === null ? null : JSON.parse(profile.score_json),
        updatedAt: profile.updated_at,
      } : null,
      observations,
      equipment,
      items,
      equipmentAnalysis: summarizeEquipment(equipment, items),
      spells: spellResult.rows.map(row => ({
        name: row.spell_name, proficiency: Number(row.proficiency), mana: Number(row.mana), updatedAt: row.updated_at,
      })),
    };
  }

  async clear(profileId) {
    if (!isProfileId(profileId)) throw new Error('Invalid profile ID.');
    const db = await this.database();
    await db.batch([
      'mud_profiles', 'mud_observations', 'mud_equipment', 'mud_items', 'mud_spells',
    ].map(table => ({ sql: `DELETE FROM ${table} WHERE profile_id = ?`, args: [profileId] })), 'write');
  }
}

let sharedStore;
let sharedConfig;
export function tursoStore(env) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw new Error('Turso is not configured.');
  if (!sharedStore || sharedConfig?.url !== env.TURSO_DATABASE_URL || sharedConfig?.authToken !== env.TURSO_AUTH_TOKEN) {
    sharedConfig = { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN };
    sharedStore = new TursoKnowledgeStore(sharedConfig);
  }
  return sharedStore;
}
