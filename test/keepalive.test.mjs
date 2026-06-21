import { test } from 'node:test';
import assert from 'node:assert';
import { decideInject, planParams, PLAN_PARAMS } from '../src/keepalive.mjs';

const NOW = 1_000_000_000_000;
const MAX = planParams('max'); // { ttl:3600, idleThreshold:3480 }
const PRO = planParams('pro'); // { ttl:300,  idleThreshold:240 }

test('plan params are the documented defaults', () => {
  assert.deepEqual(MAX, { ttl: 3600, idleThreshold: 3480 });
  assert.deepEqual(PRO, { ttl: 300, idleThreshold: 240 });
  assert.deepEqual(planParams('unknown'), PRO, 'unknown plan falls back to pro');
});

test('overrides win', () => {
  assert.deepEqual(planParams('max', { ttl: 60, idleThreshold: 60 }), { ttl: 60, idleThreshold: 60 });
});

test('max: injects when idle past threshold and cooldown clear', () => {
  assert.equal(decideInject({ now: NOW, lastInput: NOW - 3500 * 1000, lastFire: 0, ...MAX, disabled: false }), true);
});

test('disabled blocks injection', () => {
  assert.equal(decideInject({ now: NOW, lastInput: NOW - 3500 * 1000, lastFire: 0, ...MAX, disabled: true }), false);
});

test('recent user input blocks injection', () => {
  assert.equal(decideInject({ now: NOW, lastInput: NOW - 10 * 1000, lastFire: 0, ...MAX, disabled: false }), false);
});

test('cooldown blocks injection', () => {
  assert.equal(decideInject({ now: NOW, lastInput: NOW - 3500 * 1000, lastFire: NOW - 100 * 1000, ...MAX, disabled: false }), false);
});

test('injects again after cooldown passes', () => {
  assert.equal(decideInject({ now: NOW, lastInput: NOW - 3500 * 1000, lastFire: NOW - 3700 * 1000, ...MAX, disabled: false }), true);
});

test('pro: idle 250s injects, 200s does not', () => {
  assert.equal(decideInject({ now: NOW, lastInput: NOW - 250 * 1000, lastFire: 0, ...PRO, disabled: false }), true);
  assert.equal(decideInject({ now: NOW, lastInput: NOW - 200 * 1000, lastFire: 0, ...PRO, disabled: false }), false);
});

test('PLAN_PARAMS export is intact', () => {
  assert.equal(PLAN_PARAMS.max.ttl, 3600);
  assert.equal(PLAN_PARAMS.pro.idleThreshold, 240);
});
