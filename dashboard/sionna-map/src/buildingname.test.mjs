import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.window = globalThis;
const here = dirname(fileURLToPath(import.meta.url));
new Function(readFileSync(join(here, 'presets.js'), 'utf8'))();

const name = globalThis.SM.buildingName;

assert.equal(name({ '@name': 'Vessel', names: '{"primary":"Vessel"}' }), 'Vessel');
assert.equal(
  name({ '@name': 'Broadway Theatre', names: '{"common":{"ar":"برودواي"},"primary":"Broadway Theatre"}' }),
  'Broadway Theatre',
);
assert.equal(
  name({ names: '{"rules":[{"variant":"alternate","value":"Laura Pels Theatre"}],"primary":"Harold and Miriam Steinberg Center for Theatre"}' }),
  'Harold and Miriam Steinberg Center for Theatre',
);
assert.equal(name({ height: 366.3, min_height: 0, subtype: 'commercial' }), null);

assert.equal(
  name({ '@name': '三菱ビル', names: '{"common":{"ko":"미츠비시 빌딩","en":"Mitsubishi Building","es":"Edificio Mitsubishi"},"primary":"三菱ビル"}' }),
  'Mitsubishi Building',
);
assert.equal(
  name({ '@name': '大手町ビルヂング', names: '{"common":{"en":"Otemachi Building","es":"Edificio Otemachi","ja":"大手町ビルヂング"},"primary":"大手町ビルヂング"}' }),
  'Otemachi Building',
);
assert.equal(
  name({ '@name': '警察総合庁舎', names: '{"common":{"ja":"警察総合庁舎"},"primary":"警察総合庁舎"}' }),
  '警察総合庁舎',
);
assert.equal(
  name({ '@name': 'Vigyan Bhavan', names: '{"common":{"hi":"विज्ञान भवन"},"primary":"Vigyan Bhavan"}' }),
  'Vigyan Bhavan',
);
assert.equal(name({ names: '{"common":{"en-GB":"Centre Tower"},"primary":"Zentrum"}' }), 'Centre Tower');
assert.equal(
  name({ names: '{"rules":[{"variant":"alternate","language":"en","value":"Old Mill"},{"variant":"official","language":"en","value":"Royal Mill"}],"primary":"Königsmühle"}' }),
  'Royal Mill',
);
assert.equal(
  name({ names: '{"rules":[{"variant":"alternate","language":"en","value":"Only Alt"}],"primary":"Königsmühle"}' }),
  'Only Alt',
);
assert.equal(
  name({ names: '{"rules":[{"variant":"alternate","value":"Taj Hotels"}],"primary":"The Taj Mahal Hotel"}' }),
  'The Taj Mahal Hotel',
);
assert.equal(name({ names: '{"common":{"en":"   "},"primary":"Löwenbräukeller"}' }), 'Löwenbräukeller');
assert.equal(name({ '@name': 'Fallback Hall', names: 'garbage' }), 'Fallback Hall');

assert.equal(name(null), null);
assert.equal(name(undefined), null);
assert.equal(name({}), null);
assert.equal(name({ '@name': '   ' }), null);
assert.equal(name({ '@name': '  Padded  ' }), 'Padded');
assert.equal(name({ names: 'not json at all' }), null);
assert.equal(name({ names: '{"primary":' }), null);
assert.equal(name({ names: '{"common":{"ar":"x"}}' }), null);
assert.equal(name({ names: '{"primary":42}' }), null);
assert.equal(name({ names: { primary: 'Object form' } }), 'Object form');

const H = globalThis.SM.buildingHeight;

assert.deepEqual(H({ height: 366.3 }, 9), { m: 366.3, source: 'measured' });
assert.deepEqual(H({ height: 121, num_floors: 40 }, 9), { m: 121, source: 'measured' });
assert.deepEqual(H({ num_floors: 9 }, 9), { m: 27, source: 'floors', floors: 9 });
assert.deepEqual(H({}, 9), { m: 9, source: 'estimated' });
assert.deepEqual(H({ id: 'x', subtype: 'residential' }, 6), { m: 6, source: 'estimated' });
assert.deepEqual(H({}, undefined), { m: 9, source: 'estimated' });
assert.deepEqual(H(null, null), { m: 9, source: 'estimated' });
assert.equal(H({ height: 0 }, 9).source, 'estimated');
assert.equal(H({ height: -5 }, 9).source, 'estimated');
assert.equal(H({ height: 'tall' }, 9).source, 'estimated');
assert.equal(H({ num_floors: 0 }, 9).source, 'estimated');
assert.deepEqual(H({ height: '42.5' }, 9), { m: 42.5, source: 'measured' });
assert.deepEqual(H({ num_floors: '4' }, 9), { m: 12, source: 'floors', floors: 4 });
for (const p of [{}, null, { height: null }, { height: 'x' }, { num_floors: 'y' }]) {
  assert.ok(isFinite(H(p, 9).m) && H(p, 9).m > 0, `non-finite height for ${JSON.stringify(p)}`);
}

console.log('buildingName + buildingHeight: all assertions passed');
