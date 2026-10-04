import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commandCategory, createKnowledge, observe, parseCharacterCreation, parseEquipment,
  parseExamine, parseObservation, parseScore, parseSpells,
} from '../lib/observations.js';

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

test('character creation screens become structured options, skill choices, and XP costs without retaining prompt text', () => {
  const raw = `New character. Give me a password for Luna:
/ Creation \\\\ Customize \\/ Specialize \\\\
Character: Luna           Creation Points: 40        XP per level: 1000

     Race          Base Class      Sex             Weapons          Options
 [X] human     [ ] mage        [ ] male        [X] sword        [ ] Ansi Color
 [ ] elf       [ ] cleric      [X] female      [ ] mace
 [ ] dwarf     [ ] thief                       [ ] dagger
 [ ] giant     [X] warrior         Alignment   [ ] axe
 [ ] halfling                  [ ] good        [ ] staff
 [ ] kender                    [X] neutral     [ ] flail
 [ ] drow                      [ ] evil        [ ] whip
                                               [ ] polearm
Commands: customize, specialize, done, help.

       Groups                    Skills                    Skills
 [ ]  8 attack             [x]  4 bash               [ ]  5 berserk
 [ ]  8 benedictions       [x]  2 dagger             [ ]  4 dirt kicking
 [ ]  9 combat             [x]  4 disarm             [ ]  6 dodge
 [ ]  8 creation           [x]  3 enhanced damage    [ ]  4 fast healing
 [ ]  8 curative           [ ]  8 findtrap           [x]  4 flail
 [ ]  9 enhancement        [ ]  6 haggle              [ ]  4 hand to hand
 [ ]  6 harmful            [ ]  6 hide                [ ]  1 hunt
 [ ]  6 healing            [ ]  3 kick                [ ]  8 lore
 [ ]  9 maladictions       [x]  3 mace                [ ]  8 meditation
 [ ]  8 protective         [x]  4 parry               [ ]  8 peek
 [ ]  9 transportation     [ ]  8 pick lock           [x]  4 polearm
Commands: down, done, help.

       Groups                    Skills                    Skills
 [X] 40 warrior default    [*]  2 recall             [ ]  8 removetrap
 [x] 20 weaponsmaster      [x]  4 rescue             [*]  8 scrolls
 [ ]  8 weather            [*]  3 second attack      [x]  3 second weapon
                          [ ]  3 sharpen             [x]  2 shield block
                          [ ]  6 sneak               [x]  3 spear
                          [*]  8 staves              [*]  2 sword
                          [x]  4 third attack        [ ]  8 trip
                          [*]  8 wands               [x]  4 whip
                          [x]  4 axe                 [ ]  2 eyepoke
                          [*]  1 carve
Commands: creation, specialize, done, help.

The experience breakdown is as follows:
points   exp/level     points   exp/level
40        1000         90        6000
50        1500         100       8000
60        2000         110      12000
70        3000         120      16000
80        4000         130      24000`;
  const creation = parseCharacterCreation(raw);
  assert.equal(creation.characterName, 'Luna');
  assert.equal(creation.creationPoints, 40);
  assert.equal(creation.experiencePerLevel, 1000);
  assert.deepEqual(creation.selections, {
    race: 'human', baseClass: 'warrior', sex: 'female', alignment: 'neutral', weapon: 'sword', ansiColor: false,
  });
  assert.equal(creation.options.filter(option => option.category === 'race').length, 7);
  assert.deepEqual(creation.groups.find(group => group.name === 'warrior default'), {
    name: 'warrior default', cost: 40, state: 'selected',
  });
  assert.deepEqual(creation.groups.find(group => group.name === 'weaponsmaster'), {
    name: 'weaponsmaster', cost: 20, state: 'inherited',
  });
  assert.deepEqual(creation.skills.find(skill => skill.name === 'recall'), {
    name: 'recall', cost: 2, state: 'fixed',
  });
  assert.deepEqual(creation.skills.find(skill => skill.name === 'bash'), {
    name: 'bash', cost: 4, state: 'inherited',
  });
  assert.deepEqual(creation.experienceCurve[0], { creationPoints: 40, experiencePerLevel: 1000 });
  assert.deepEqual(creation.experienceCurve.at(-1), { creationPoints: 130, experiencePerLevel: 24000 });

  const observation = parseObservation('creation', raw);
  assert.ok(observation);
  assert.equal(observation.raw.includes('password'), false);
  assert.equal(commandCategory('creation')?.command, 'creation');
});
