import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.window = globalThis;
const here = dirname(fileURLToPath(import.meta.url));
new Function(readFileSync(join(here, 'sionna.js'), 'utf8'))();

const summary = globalThis.SM.coverageSummary;

const STATS = {
  covered_cells: 5316,
  total_cells: 10266,
  coverage: {
    rss: { threshold_db: -90, unit: 'dBm', fraction_of_served: 0.804, fraction_of_area: 0.481 },
    sinr: { threshold_db: 0, unit: 'dB', fraction_of_served: 0.992, fraction_of_area: 0.593 },
  },
};
const OV = {
  units: { path_gain: 'dB', rss: 'dBm', sinr: 'dB' },
  scales: { path_gain: [-140, -60], rss: [-120, -40], sinr: [-10, 40] },
};

{
  const t = summary(OV, STATS, 'rss');
  assert.ok(t.includes('-120..-40 dBm'), 'RSS scale must be captioned dBm: ' + t);
  assert.ok(!/-120\.\.-40 dB(?!m)/.test(t), 'RSS must not be captioned plain dB: ' + t);
}
assert.ok(summary(OV, STATS, 'sinr').includes('-10..40 dB'), 'SINR is a ratio and is dB');
assert.ok(summary(OV, STATS, 'path_gain').includes('-140..-60 dB'), 'path gain is dB');

{
  const t = summary(OV, STATS, 'rss');
  assert.ok(t.includes('5316/10266 cells reached'), 'the reached count says reached: ' + t);
  assert.ok(t.includes('48.1% of area'), 'the coverage figure is the area one: ' + t);
  assert.ok(t.includes('≥ -90 dBm'), 'coverage carries its threshold: ' + t);
}

{
  const t = summary(OV, { covered_cells: 10, total_cells: 20 }, 'rss');
  assert.ok(t.includes('10/20 cells reached'));
  assert.ok(!t.includes('% of area'), 'nothing measured it, so it must not be claimed: ' + t);
}

{
  const ov = { ...OV, contested: { cells: 48, served: 5049, margin_db: 3, judgeable_fraction: 0.95 } };
  const t = summary(ov, STATS, 'rss');
  assert.ok(t.includes('contested 1.0% at 3 dB'), t);
  assert.ok(!t.includes('has been reached by more than one'), 'judgeable is fine at 95%: ' + t);
}
{
  const ov = { ...OV, contested: { cells: 0, served: 5316, margin_db: 3, judgeable_fraction: 0.0 } };
  const t = summary(ov, STATS, 'rss');
  assert.ok(t.includes('only 0% of it has been reached by more than one transmitter'), t);
}

assert.equal(summary(OV, null, 'rss'), 'Coverage overlay loaded.');
assert.ok(summary(null, STATS, 'rss').includes('cells reached'), 'no overlay is not a crash');
assert.ok(summary({}, STATS, 'rss').includes('cells reached'), 'no units is not a crash');
{
  const t = summary(OV, STATS, 'rsrq');
  assert.ok(t.startsWith('rsrq:'), t);
}

console.log('  ok    coverage caption: units, reached vs covered, contested, and bad input');
