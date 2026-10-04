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
  `CREATE TABLE IF NOT EXISTS mud_active_affects (
    profile_id TEXT NOT NULL,
    effect_name TEXT NOT NULL,
    attribute TEXT NOT NULL,
    amount INTEGER NOT NULL,
    duration TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, effect_name, attribute)
  )`,
  `CREATE TABLE IF NOT EXISTS mud_score_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    score_json TEXT NOT NULL,
    captured_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS mud_score_history_profile_idx ON mud_score_history(profile_id, id)',
  `CREATE TABLE IF NOT EXISTS mud_character_builds (
    profile_id TEXT PRIMARY KEY,
    character_name TEXT,
    race TEXT,
    base_class TEXT,
    sex TEXT,
    alignment TEXT,
    weapon TEXT,
    ansi_color INTEGER,
    creation_points INTEGER,
    exp_per_level INTEGER,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mud_creation_options (
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (category, name)
  )`,
  `CREATE TABLE IF NOT EXISTS mud_creation_skill_catalog (
    entry_type TEXT NOT NULL,
    name TEXT NOT NULL,
    cost INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (entry_type, name)
  )`,
  `CREATE TABLE IF NOT EXISTS mud_character_skill_choices (
    profile_id TEXT NOT NULL,
    entry_type TEXT NOT NULL,
    name TEXT NOT NULL,
    cost INTEGER NOT NULL,
    selection_state TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, entry_type, name)
  )`,
  `CREATE TABLE IF NOT EXISTS mud_creation_xp_curve (
    creation_points INTEGER PRIMARY KEY,
    experience_per_level INTEGER NOT NULL,
    updated_at TEXT NOT NULL
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

    if (category === 'score') {
      const scoreJson = JSON.stringify(data);
      if (data.name) statements.push({
        sql: `UPDATE mud_profiles SET character_name = ?, score_json = ?, updated_at = ?
          WHERE profile_id = ?`,
        args: [data.name, scoreJson, updatedAt, profileId],
      });
      statements.push({
        sql: `INSERT INTO mud_score_history(profile_id, score_json, captured_at)
          SELECT ?, ?, ?
          WHERE COALESCE((
            SELECT score_json FROM mud_score_history WHERE profile_id = ? ORDER BY id DESC LIMIT 1
          ), '') != ?`,
        args: [profileId, scoreJson, updatedAt, profileId, scoreJson],
      });
    }
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
    if (category === 'affect') {
      statements.push({ sql: 'DELETE FROM mud_active_affects WHERE profile_id = ?', args: [profileId] });
      for (const effect of data) statements.push({
        sql: `INSERT INTO mud_active_affects(
            profile_id, effect_name, attribute, amount, duration, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [profileId, effect.name, effect.attribute, effect.amount, effect.duration, updatedAt],
      });
    }
    if (category === 'creation') {
      const { characterName, creationPoints, experiencePerLevel, selections } = data;
      statements.push({
        sql: `UPDATE mud_profiles SET character_name = ?, updated_at = ? WHERE profile_id = ?`,
        args: [characterName, updatedAt, profileId],
      }, {
        sql: `INSERT INTO mud_character_builds(
            profile_id, character_name, race, base_class, sex, alignment, weapon, ansi_color,
            creation_points, exp_per_level, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_id) DO UPDATE SET
            character_name = excluded.character_name,
            race = COALESCE(excluded.race, mud_character_builds.race),
            base_class = COALESCE(excluded.base_class, mud_character_builds.base_class),
            sex = COALESCE(excluded.sex, mud_character_builds.sex),
            alignment = COALESCE(excluded.alignment, mud_character_builds.alignment),
            weapon = COALESCE(excluded.weapon, mud_character_builds.weapon),
            ansi_color = COALESCE(excluded.ansi_color, mud_character_builds.ansi_color),
            creation_points = excluded.creation_points,
            exp_per_level = excluded.exp_per_level,
            updated_at = excluded.updated_at`,
        args: [
          profileId, characterName, selections.race, selections.baseClass, selections.sex,
          selections.alignment, selections.weapon, Number(selections.ansiColor),
          creationPoints, experiencePerLevel, updatedAt,
        ],
      });
      for (const option of data.options) statements.push({
        sql: `INSERT INTO mud_creation_options(category, name, display_name, sort_order, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(category, name) DO UPDATE SET
            display_name = excluded.display_name, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
        args: [option.category, option.name, option.displayName, option.sortOrder, updatedAt],
      });
      for (const [entryType, entries] of [['group', data.groups], ['skill', data.skills]]) {
        for (const entry of entries) {
          statements.push({
            sql: `INSERT INTO mud_creation_skill_catalog(entry_type, name, cost, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(entry_type, name) DO UPDATE SET cost = excluded.cost, updated_at = excluded.updated_at`,
            args: [entryType, entry.name, entry.cost, updatedAt],
          }, {
            sql: `INSERT INTO mud_character_skill_choices(
                profile_id, entry_type, name, cost, selection_state, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(profile_id, entry_type, name) DO UPDATE SET
                cost = excluded.cost, selection_state = excluded.selection_state, updated_at = excluded.updated_at`,
            args: [profileId, entryType, entry.name, entry.cost, entry.state, updatedAt],
          });
        }
      }
      for (const point of data.experienceCurve) statements.push({
        sql: `INSERT INTO mud_creation_xp_curve(creation_points, experience_per_level, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(creation_points) DO UPDATE SET
            experience_per_level = excluded.experience_per_level, updated_at = excluded.updated_at`,
        args: [point.creationPoints, point.experiencePerLevel, updatedAt],
      });
    }
    await db.batch(statements, 'write');
    return true;
  }

  async get(profileId) {
    if (!isProfileId(profileId)) throw new Error('Invalid profile ID.');
    const db = await this.database();
    const [
      profileResult, observationResult, equipmentResult, itemResult, spellResult,
      activeAffectResult, scoreHistoryResult, buildResult, optionResult, skillCatalogResult,
      skillChoiceResult, xpCurveResult,
    ] = await Promise.all([
      db.execute({ sql: 'SELECT character_name, score_json, updated_at FROM mud_profiles WHERE profile_id = ?', args: [profileId] }),
      db.execute({ sql: 'SELECT command, subject, raw_text, data_json, updated_at FROM mud_observations WHERE profile_id = ? ORDER BY command, subject', args: [profileId] }),
      db.execute({ sql: 'SELECT slot, item_name, flags_json, updated_at FROM mud_equipment WHERE profile_id = ? ORDER BY slot', args: [profileId] }),
      db.execute({ sql: 'SELECT item_name, subject, raw_text, data_json, updated_at FROM mud_items WHERE profile_id = ? ORDER BY item_name', args: [profileId] }),
      db.execute({ sql: 'SELECT spell_name, proficiency, mana, updated_at FROM mud_spells WHERE profile_id = ? ORDER BY spell_name', args: [profileId] }),
      db.execute({ sql: 'SELECT effect_name, attribute, amount, duration, updated_at FROM mud_active_affects WHERE profile_id = ? ORDER BY effect_name, attribute', args: [profileId] }),
      db.execute({ sql: 'SELECT score_json, captured_at FROM mud_score_history WHERE profile_id = ? ORDER BY id DESC LIMIT 20', args: [profileId] }),
      db.execute({ sql: 'SELECT * FROM mud_character_builds WHERE profile_id = ?', args: [profileId] }),
      db.execute({ sql: 'SELECT category, name, display_name, sort_order FROM mud_creation_options ORDER BY category, sort_order' }),
      db.execute({ sql: 'SELECT entry_type, name, cost FROM mud_creation_skill_catalog ORDER BY entry_type, name' }),
      db.execute({ sql: 'SELECT entry_type, name, cost, selection_state, updated_at FROM mud_character_skill_choices WHERE profile_id = ? ORDER BY entry_type, name', args: [profileId] }),
      db.execute({ sql: 'SELECT creation_points, experience_per_level FROM mud_creation_xp_curve ORDER BY creation_points' }),
    ]);
    const observations = observationResult.rows.map(row => ({
      command: row.command, subject: row.subject, raw: row.raw_text,
      data: row.data_json === null ? null : JSON.parse(row.data_json), updatedAt: row.updated_at,
    }));
    const profile = profileResult.rows[0];
    const build = buildResult.rows[0];
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
      activeAffects: activeAffectResult.rows.map(row => ({
        name: row.effect_name, attribute: row.attribute, amount: Number(row.amount),
        duration: row.duration, updatedAt: row.updated_at,
      })),
      scoreHistory: scoreHistoryResult.rows.map(row => ({
        score: JSON.parse(row.score_json), capturedAt: row.captured_at,
      })),
      characterCreation: {
        build: build ? {
          characterName: build.character_name,
          race: build.race,
          baseClass: build.base_class,
          sex: build.sex,
          alignment: build.alignment,
          weapon: build.weapon,
          ansiColor: Boolean(build.ansi_color),
          creationPoints: Number(build.creation_points),
          experiencePerLevel: Number(build.exp_per_level),
          updatedAt: build.updated_at,
        } : null,
        options: optionResult.rows.map(row => ({
          category: row.category, name: row.name, displayName: row.display_name, sortOrder: Number(row.sort_order),
        })),
        skillCatalog: skillCatalogResult.rows.map(row => ({
          type: row.entry_type, name: row.name, cost: Number(row.cost),
        })),
        skillChoices: skillChoiceResult.rows.map(row => ({
          type: row.entry_type, name: row.name, cost: Number(row.cost),
          state: row.selection_state, updatedAt: row.updated_at,
        })),
        experienceCurve: xpCurveResult.rows.map(row => ({
          creationPoints: Number(row.creation_points), experiencePerLevel: Number(row.experience_per_level),
        })),
      },
    };
  }

  async clear(profileId) {
    if (!isProfileId(profileId)) throw new Error('Invalid profile ID.');
    const db = await this.database();
    await db.batch([
      'mud_profiles', 'mud_observations', 'mud_equipment', 'mud_items', 'mud_spells',
      'mud_active_affects', 'mud_score_history', 'mud_character_builds', 'mud_character_skill_choices',
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
