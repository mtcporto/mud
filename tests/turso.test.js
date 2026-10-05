import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItemKey, summarizeEquipment, TursoKnowledgeStore } from '../lib/turso.js';
import { isProfileId } from '../lib/profile.js';

const profileId = '410b4c85-7ff2-4bd2-94bb-3e241e791c05';

test('Turso store validates opaque profiles and batches parsed observations safely', async () => {
  const executed = [], batches = [];
  const client = {
    async execute(statement) {
      executed.push(statement);
      return { rows: [] };
    },
    async batch(statements, mode) {
      batches.push({ statements, mode });
      return [];
    },
  };
  const store = new TursoKnowledgeStore({
    url: 'libsql://example.turso.io',
    authToken: 'test-token',
    clientFactory: () => client,
  });
  assert.equal(isProfileId(profileId), true);
  assert.equal(isProfileId('not-a-profile'), false);
  assert.equal(normalizeItemKey('green robes'), normalizeItemKey('robes green'));
  const perspective = summarizeEquipment([
    { slot: 'worn about body', name: 'green robes', flags: [] },
    { slot: 'worn around wrist', name: 'Ammonet Brassard', flags: [] },
  ], [{
    name: 'robes green',
    data: { affects: [{ attribute: 'saving-spell', amount: -10 }], immunities: ['poison'] },
  }]);
  assert.equal(perspective.equipped[0].examined.affects[0].amount, -10);
  assert.deepEqual(perspective.unexamined, [{ slot: 'worn around wrist', name: 'Ammonet Brassard' }]);
  assert.deepEqual(perspective.knownModifiers, { 'saving-spell': -10 });
  assert.deepEqual(perspective.knownImmunities, ['poison']);
  assert.equal(await store.save(profileId, 'drink water', 'untracked output'), false);
  assert.equal(await store.save(profileId, 'score', 'Name : Elvinn Level : 91\nStr: 16 (20) Hit: 7073/7073'), true);

  assert.equal(executed.length, 16);
  assert.ok(executed.some(statement => String(statement).includes('INSERT INTO mud_score_history')));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].mode, 'write');
  assert.ok(batches[0].statements.some(statement => statement.sql.includes('INSERT INTO mud_observations')));
  assert.ok(batches[0].statements.some(statement => statement.sql.includes('score_json')));
  const scoreUpdate = batches[0].statements.find(statement => statement.sql.includes('score_json'));
  assert.equal(scoreUpdate.args[0], 'Elvinn');
  assert.ok(batches[0].statements.some(statement => statement.sql.includes('INSERT INTO mud_score_history')));

  await store.save(profileId, 'effect', `Spell: 'armor' modifies armor by -20 for 12 hours.`);
  const effectObservation = batches[1].statements.find(statement => statement.sql.includes('INSERT INTO mud_observations'));
  assert.deepEqual(JSON.parse(effectObservation.args[4]), [
    { name: 'armor', attribute: 'armor', amount: -20, duration: '12 hours' },
  ]);

  assert.equal(await store.save(profileId, 'examine sword', 'You do not see that here.'), false);
  await store.save(profileId, 'examine sword', 'You see a sword of great but cheap craftsmanship.');
  assert.ok(batches[2].statements.some(statement => statement.sql.includes('DELETE FROM mud_observations')));
  assert.ok(batches[2].statements.some(statement => statement.sql.includes('DELETE FROM mud_items')));
  assert.ok(batches[2].statements.some(statement => statement.sql.includes('item_name, subject, raw_text')));

  await store.save(profileId, 'equipment', `<worn around wrist> Ammonet's Brassard
<worn around wrist> Ammonet's Brassard`);
  assert.equal(batches[3].statements.filter(statement => statement.sql.includes('INSERT INTO mud_equipment')).length, 2);
  await store.clear(profileId);
  assert.equal(batches[4].statements.length, 10);
  assert.ok(batches[4].statements.every(statement => statement.args[0] === profileId));
});

test('Turso persists command discoveries as reusable observations', async () => {
  const batches = [];
  const store = new TursoKnowledgeStore({
    url: 'libsql://example.turso.io',
    authToken: 'test-token',
    clientFactory: () => ({
      async execute() { return { rows: [] }; },
      async batch(statements, mode) { batches.push({ statements, mode }); return []; },
    }),
  });
  for (const command of ['skills', 'quest', 'exits', 'consider goblin', 'say questmaster']) {
    assert.equal(await store.save(profileId, command, `Observed response for ${command}.`), true);
  }
  assert.equal(batches.length, 5);
  for (const [index, command] of ['skills', 'quest', 'exits', 'consider goblin', 'say questmaster'].entries()) {
    const observation = batches[index].statements.find(statement => statement.sql.includes('INSERT INTO mud_observations'));
    assert.equal(observation.args[1], command.split(' ')[0]);
    assert.equal(observation.args[3], `Observed response for ${command}.`);
  }
});

test('Turso stores creation catalogs, per-character choices, and a sanitized structured snapshot', async () => {
  const batches = [];
  const client = {
    async execute() { return { rows: [] }; },
    async batch(statements, mode) { batches.push({ statements, mode }); return []; },
  };
  const store = new TursoKnowledgeStore({
    url: 'libsql://example.turso.io',
    authToken: 'test-token',
    clientFactory: () => client,
  });
  const raw = `Password: (hidden)
Character: Luna Creation Points: 40 XP per level: 1000
Race Base Class Sex Weapons Options
[X] human [ ] mage [ ] male [X] sword [ ] Ansi Color
[ ] elf [ ] cleric [X] female [ ] mace
[ ] dwarf [ ] thief [ ] dagger
[ ] giant [X] warrior Alignment [ ] axe
[ ] halfling [ ] good [ ] staff
[ ] kender [X] neutral [ ] flail
[ ] drow [ ] evil [ ] whip
[ ] polearm
Commands: done
Groups Skills Skills
[X] 40 warrior default [*] 2 recall [ ] 8 removetrap
[x] 20 weaponsmaster [x] 4 rescue [*] 8 scrolls
Commands: done
The experience breakdown is as follows:
points exp/level points exp/level
40 1000 90 6000`;
  assert.equal(await store.save(profileId, 'creation', raw), true);

  const statements = batches[0].statements;
  assert.equal(batches[0].mode, 'write');
  const observation = statements.find(statement => statement.sql.includes('INSERT INTO mud_observations'));
  assert.equal(observation.args[1], 'creation');
  assert.equal(observation.args[3].includes('Password'), false);
  assert.equal(observation.args[3].includes('"characterName":"Luna"'), true);
  assert.ok(statements.some(statement => statement.sql.includes('INSERT INTO mud_character_builds')));
  assert.ok(statements.some(statement => statement.sql.includes('INSERT INTO mud_creation_options')));
  assert.ok(statements.some(statement => statement.sql.includes('INSERT INTO mud_creation_skill_catalog')));
  assert.ok(statements.some(statement => statement.sql.includes('INSERT INTO mud_character_skill_choices')));
  assert.ok(statements.some(statement => statement.sql.includes('INSERT INTO mud_creation_xp_curve')));
  const build = statements.find(statement => statement.sql.includes('INSERT INTO mud_character_builds'));
  assert.deepEqual(build.args.slice(1, 10), ['Luna', 'human', 'warrior', 'female', 'neutral', 'sword', 0, 40, 1000]);
});

test('Turso stores room observations under the room name with structured exits', async () => {
  const batches = [];
  const client = {
    async execute() { return { rows: [] }; },
    async batch(statements, mode) { batches.push({ statements, mode }); return []; },
  };
  const store = new TursoKnowledgeStore({
    url: 'libsql://example.turso.io',
    authToken: 'test-token',
    clientFactory: () => client,
  });
  await store.save(profileId, 'look', `Temple Of Fatal
Large steps lead through the temple gate.
20/20hp 100/100ma 50mv | NSU >`);

  const observation = batches[0].statements.find(statement => statement.sql.includes('INSERT INTO mud_observations'));
  assert.equal(observation.args[1], 'look');
  assert.match(observation.args[2], /^temple of fatal#[a-z0-9]+$/);
  assert.deepEqual(JSON.parse(observation.args[4]), {
    name: 'Temple Of Fatal',
    description: 'Large steps lead through the temple gate.',
    exits: ['N', 'S', 'U'],
    visibleEntities: [],
  });
  await store.save(profileId, 'look', `Temple Of Fatal
Steps descend to the square.
20/20hp 100/100ma 50mv | NSU >`);
  const secondRoom = batches[1].statements.find(statement => statement.sql.includes('INSERT INTO mud_observations'));
  assert.notEqual(secondRoom.args[2], observation.args[2]);
});

test('Turso stores practice reports and individual practice updates separately from spells', async () => {
  const batches = [];
  const client = {
    async execute() { return { rows: [] }; },
    async batch(statements, mode) { batches.push({ statements, mode }); return []; },
  };
  const store = new TursoKnowledgeStore({
    url: 'libsql://example.turso.io',
    authToken: 'test-token',
    clientFactory: () => client,
  });
  await store.save(profileId, 'practice', `bash 55% (55%)  sword 75% (75%)
You have 7 practice sessions left.`);
  assert.ok(batches[0].statements.some(statement => statement.sql.includes('DELETE FROM mud_practices')));
  assert.equal(batches[0].statements.filter(statement => statement.sql.includes('INSERT INTO mud_practices')).length, 2);
  await store.save(profileId, 'practice sword', `You practice sword.
sword is now at 80 percent, 6 practices left.`);
  const update = batches[1].statements.find(statement => statement.sql.includes('INSERT INTO mud_practices'));
  assert.deepEqual(update.args.slice(0, 4), [profileId, 'sword', 80, 80]);
  assert.equal(typeof update.args[4], 'string');
});

test('Turso reads join examined details to worn gear and retain the current score snapshot', async () => {
  const client = {
    async execute(statement) {
      if (typeof statement === 'string') return { rows: [] };
      if (statement.sql.includes('SELECT character_name')) return { rows: [{
        character_name: 'Elvinn', score_json: JSON.stringify({ name: 'Elvinn', level: 91 }), updated_at: '2026-10-03T00:00:00.000Z',
      }] };
      if (statement.sql.includes('SELECT command')) return { rows: [{
        command: 'effect', subject: '', raw_text: '- protection good\n- shield',
        data_json: JSON.stringify([
          { name: 'protection good', attribute: null, amount: null, duration: null },
          { name: 'shield', attribute: null, amount: null, duration: null },
        ]),
        updated_at: 'now',
      }] };
      if (statement.sql.includes('SELECT slot')) return { rows: [
        { slot: 'worn about body', item_name: 'green robes', flags_json: '["Magical"]', updated_at: 'now' },
        { slot: 'worn around wrist', item_name: 'Ammonet Brassard', flags_json: '[]', updated_at: 'now' },
        { slot: 'worn around wrist', item_name: 'Ammonet Brassard', flags_json: '[]', updated_at: 'now' },
      ] };
      if (statement.sql.includes('SELECT item_name')) return { rows: [{
        item_name: 'robes green', subject: 'green robe', raw_text: 'Affects saving-spell by -10.',
        data_json: JSON.stringify({ affects: [{ attribute: 'saving-spell', amount: -10 }], immunities: ['poison'] }),
        updated_at: 'now',
      }] };
      if (statement.sql.includes('SELECT spell_name')) return { rows: [] };
      if (statement.sql.includes('SELECT skill_name')) return { rows: [{
        skill_name: 'sword', proficiency: 75, base_proficiency: 75, updated_at: 'now',
      }] };
      if (statement.sql.includes('SELECT score_json, captured_at FROM mud_score_history')) return { rows: [
        { score_json: JSON.stringify({ alignment: 0 }), captured_at: 'now' },
      ] };
      if (statement.sql.includes('SELECT * FROM mud_character_builds')) return { rows: [{
        character_name: 'Luna', race: 'human', base_class: 'warrior', sex: 'female',
        alignment: 'neutral', weapon: 'sword', ansi_color: 0, creation_points: 40,
        exp_per_level: 1000, updated_at: 'now',
      }] };
      if (statement.sql.includes('SELECT category, name, display_name')) return { rows: [
        { category: 'race', name: 'human', display_name: 'human', sort_order: 0 },
      ] };
      if (statement.sql.includes('SELECT entry_type, name, cost, selection_state')) return { rows: [
        { entry_type: 'group', name: 'warrior default', cost: 40, selection_state: 'selected', updated_at: 'now' },
      ] };
      if (statement.sql.includes('SELECT entry_type, name, cost FROM mud_creation_skill_catalog')) return { rows: [
        { entry_type: 'group', name: 'warrior default', cost: 40 },
      ] };
      if (statement.sql.includes('SELECT creation_points, experience_per_level')) return { rows: [
        { creation_points: 40, experience_per_level: 1000 },
      ] };
      throw new Error(`Unexpected SQL: ${statement.sql}`);
    },
  };
  const store = new TursoKnowledgeStore({
    url: 'libsql://example.turso.io',
    authToken: 'test-token',
    clientFactory: () => client,
  });
  const result = await store.get(profileId);
  assert.equal(result.profile.characterName, 'Elvinn');
  assert.deepEqual(result.scoreHistory, [{ score: { alignment: 0 }, capturedAt: 'now' }]);
  assert.deepEqual(result.activeEffects, [{
    name: 'protection good', attribute: null, amount: null, duration: null,
  }, {
    name: 'shield', attribute: null, amount: null, duration: null,
  }]);
  assert.equal(result.equipment.length, 3);
  assert.deepEqual(result.practiceSkills, [{
    name: 'sword', proficiency: 75, baseProficiency: 75, updatedAt: 'now',
  }]);
  assert.equal(result.equipmentAnalysis.equipped[0].examined.affects[0].amount, -10);
  assert.equal(result.equipmentAnalysis.unexamined.length, 2);
  assert.deepEqual(result.equipmentAnalysis.knownModifiers, { 'saving-spell': -10 });
  assert.deepEqual(result.characterCreation.build, {
    characterName: 'Luna', race: 'human', baseClass: 'warrior', sex: 'female',
    alignment: 'neutral', weapon: 'sword', ansiColor: false, creationPoints: 40,
    experiencePerLevel: 1000, updatedAt: 'now',
  });
  assert.deepEqual(result.characterCreation.skillChoices, [{
    type: 'group', name: 'warrior default', cost: 40, state: 'selected', updatedAt: 'now',
  }]);
  assert.deepEqual(result.characterCreation.experienceCurve, [{
    creationPoints: 40, experiencePerLevel: 1000,
  }]);
});
