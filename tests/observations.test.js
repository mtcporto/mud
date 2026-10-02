import test from 'node:test';
import assert from 'node:assert/strict';
import { commandCategory, createKnowledge, observe } from '../lib/observations.js';

test('knowledge categorizes useful MUD reports without interpreting arbitrary output', () => {
  assert.deepEqual(commandCategory('examine silver sword'), { command: 'examine', subject: 'silver sword' });
  assert.equal(commandCategory('say score'), null);
  const knowledge = createKnowledge();
  observe(knowledge, 'score', 'Name: Ada\nClass: Mage\nRace: Elf');
  observe(knowledge, 'spells', 'fireball\nheal');
  observe(knowledge, 'equip', 'silver sword');
  observe(knowledge, 'examine silver sword', 'Damage: 4-8\nArmor: 0');
  assert.match(knowledge.score, /Class: Mage/);
  assert.match(knowledge.examined['silver sword'], /Damage/);
});
