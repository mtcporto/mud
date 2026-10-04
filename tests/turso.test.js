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
  assert.equal(await store.save(profileId, 'say hello', 'untracked output'), false);
  assert.equal(await store.save(profileId, 'score', 'Name : Elvinn Level : 91\nStr: 16 (20) Hit: 7073/7073'), true);

  assert.equal(executed.length, 6);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].mode, 'write');
  assert.ok(batches[0].statements.some(statement => statement.sql.includes('INSERT INTO mud_observations')));
  assert.ok(batches[0].statements.some(statement => statement.sql.includes('score_json')));
  const scoreUpdate = batches[0].statements.find(statement => statement.sql.includes('score_json'));
  assert.equal(scoreUpdate.args[0], 'Elvinn');

  await store.save(profileId, 'equip', `<worn around wrist> Ammonet's Brassard
<worn around wrist> Ammonet's Brassard`);
  assert.equal(batches[1].statements.filter(statement => statement.sql.includes('INSERT INTO mud_equipment')).length, 2);
  await store.clear(profileId);
  assert.equal(batches[2].statements.length, 5);
  assert.ok(batches[2].statements.every(statement => statement.args[0] === profileId));
});

test('Turso reads join examined details to worn gear and retain the current score snapshot', async () => {
  const client = {
    async execute(statement) {
      if (typeof statement === 'string') return { rows: [] };
      if (statement.sql.includes('SELECT character_name')) return { rows: [{
        character_name: 'Elvinn', score_json: JSON.stringify({ name: 'Elvinn', level: 91 }), updated_at: '2026-10-03T00:00:00.000Z',
      }] };
      if (statement.sql.includes('SELECT command')) return { rows: [] };
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
  assert.equal(result.equipment.length, 3);
  assert.equal(result.equipmentAnalysis.equipped[0].examined.affects[0].amount, -10);
  assert.equal(result.equipmentAnalysis.unexamined.length, 2);
  assert.deepEqual(result.equipmentAnalysis.knownModifiers, { 'saving-spell': -10 });
});
