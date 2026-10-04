import test from 'node:test';
import assert from 'node:assert/strict';
import { commandCategory, createKnowledge, observe, parseEquipment, parseExamine, parseScore, parseSpells } from '../lib/observations.js';

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

test('score, equipment, examined-item effects and spells are parsed into structured facts', () => {
  const score = parseScore(`| Name : Elvinn            Level   :    91                            |
| Race : elf               Age     :   247 years                      |
| Class: cleric            Played  :  4617 hours                      |
| Str: 16 (20)     Experience : 113778       Hit  :  7073/ 7073       |
| Int: 20 (22)     Next level :   1222       Mana :  4051/ 4051       |
| Wis: 20 (23)     Questpoints:    444       Move :   810/  810       |
| Hitroll: 80      Damroll: 90`);
  assert.equal(score.name, 'Elvinn');
  assert.equal(score.race, 'elf');
  assert.equal(score.class, 'cleric');
  assert.deepEqual(score.attributes.str, { base: 16, modified: 20 });
  assert.deepEqual(score.resources.hit, { current: 7073, maximum: 7073 });
  assert.equal(score.experience, 113778);
  assert.equal(score.next_level, 1222);

  const equipment = parseEquipment(`<worn on body>  (Magical) (Glowing) (Humming) Elvish Armor of the Gods
<worn about body>   (Magical) green robes
<worn as shield>    -`);
  assert.equal(equipment.length, 2);
  assert.deepEqual(equipment[1], { slot: 'worn about body', name: 'green robes', flags: ['Magical'] });

  const item = parseExamine(`object 'robes green' is armor for about
value is 56000
level is 90
extra flags magic non_metal freeze_proof burn_proof
Armor class is 35 pierce, 33 bash, 34 slash, and 40 vs. magic.
Affects saving-spell by -10.
Adds immunity to poison.
Affects none by 0.`);
  assert.equal(item.objectName, 'robes green');
  assert.equal(item.value, 56000);
  assert.equal(item.level, 90);
  assert.deepEqual(item.armor, { pierce: 35, bash: 33, slash: 34, magic: 40 });
  assert.deepEqual(item.affects, [{ attribute: 'saving-spell', amount: -10 }]);
  assert.deepEqual(item.immunities, ['poison']);

  const spells = parseSpells(`1: cause light          75% ( 38%)  15ma  cure light           93% ( 47%)  10ma
   2: armor               100% ( 95%)   5ma`);
  assert.deepEqual(spells, [
    { name: 'cause light', proficiency: 75, mana: 15 },
    { name: 'cure light', proficiency: 93, mana: 10 },
    { name: 'armor', proficiency: 100, mana: 5 },
  ]);
});
