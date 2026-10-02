const test = require('node:test');
const assert = require('node:assert');
const { Mutex, LockManager } = require('../src/locks');
const { createRng, yieldMicrotasks, setup } = require('./helpers');

function setupWithYields(seed) {
  const rng = createRng(seed);
  return setup({ io: () => yieldMicrotasks(rng.int(1, 4)) });
}

function countOk(results) {
  return results.filter((r) => r.ok).length;
}

test('sanity check: removing the locks lets two users hold the same seat', async () => {
  const noLocks = { withLocks: (keys, fn) => fn() };
  const { engine } = setup({ locks: noLocks, io: () => yieldMicrotasks(1) });

  const results = await Promise.all([engine.hold('1', 'A', 60), engine.hold('1', 'B', 60)]);

  assert.strictEqual(countOk(results), 2); 
});

test('two users holding the same seat at the same time: exactly one wins', async () => {
  for (let seed = 1; seed <= 50; seed++) {
    const { engine } = setupWithYields(seed);
    const results = await Promise.all([engine.hold('1', 'A', 60), engine.hold('1', 'B', 60)]);

    assert.strictEqual(countOk(results), 1);
    assert.strictEqual(results.find((r) => !r.ok).error, 'SEAT_HELD');
  }
});

test('20 users racing for one seat: exactly one winner', async () => {
  const { engine } = setupWithYields(7);
  const tasks = [];
  for (let i = 0; i < 20; i++) tasks.push(engine.hold('1', `user${i}`, 60));

  const results = await Promise.all(tasks);

  assert.strictEqual(countOk(results), 1);
  assert.strictEqual(engine.holds.size, 1);
});

test('holdMany A:[1,2] vs B:[2,1] does not deadlock and exactly one user wins both seats', async () => {
  for (let seed = 1; seed <= 100; seed++) {
    const { engine } = setupWithYields(seed);

    const [a, b] = await Promise.all([engine.holdMany('A', ['1', '2']), engine.holdMany('B', ['2', '1'])]);

    assert.strictEqual(countOk([a, b]), 1);
    const winner = a.ok ? 'A' : 'B';
    assert.deepStrictEqual(engine.seatStatus('1').user, winner);
    assert.deepStrictEqual(engine.seatStatus('2').user, winner);
  }
});

test('three overlapping holdMany calls in different orders: one winner, no leftovers from losers', async () => {
  for (let seed = 1; seed <= 50; seed++) {
    const { engine } = setupWithYields(seed);

    const results = await Promise.all([
      engine.holdMany('A', ['1', '2', '3']),
      engine.holdMany('B', ['3', '2', '1']),
      engine.holdMany('C', ['2', '3', '1']),
    ]);

    assert.strictEqual(countOk(results), 1);
    assert.strictEqual(engine.holds.size, 3); 
  }
});

test('holdMany calls on different seats both succeed concurrently', async () => {
  const { engine } = setupWithYields(3);

  const [a, b] = await Promise.all([engine.holdMany('A', ['1', '2']), engine.holdMany('B', ['3', '4'])]);

  assert.ok(a.ok && b.ok);
});

test('one user firing 6 hold() calls at once never ends up with more than 4 holds (R2)', async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { engine } = setupWithYields(seed);
    const tasks = ['1', '2', '3', '4', '5', '6'].map((seatId) => engine.hold(seatId, 'A', 60));

    const results = await Promise.all(tasks);

    assert.strictEqual(countOk(results), 4);
    assert.strictEqual(engine.userHolds.get('A').size, 4);
  }
});

test('one user firing overlapping holdMany calls cannot exceed 4 holds', async () => {
  const { engine } = setupWithYields(11);

  const results = await Promise.all([
    engine.holdMany('A', ['1', '2', '3']),
    engine.holdMany('A', ['4', '5', '6']),
    engine.holdMany('A', ['7', '8']),
  ]);

  const holdsOwned = results.filter((r) => r.ok).reduce((sum, r) => sum + r.holdIds.length, 0);
  assert.ok(holdsOwned <= 4);
  assert.strictEqual(engine.userHolds.get('A').size, holdsOwned);
});

test('confirm racing with release on the same hold: exactly one succeeds', async () => {
  for (let seed = 1; seed <= 50; seed++) {
    const { engine } = setupWithYields(seed);
    const { holdId } = await engine.hold('1', 'A', 60);

    const results = await Promise.all([engine.confirm(holdId), engine.release(holdId)]);

    assert.strictEqual(countOk(results), 1);
  }
});

test('confirm at exactly expiresAt is rejected (expiry boundary)', async () => {
  const { engine, clock } = setupWithYields(5);
  const { holdId } = await engine.hold('1', 'A', 10);
  clock.advance(10); 

  const result = await engine.confirm(holdId);

  assert.deepStrictEqual(result, { ok: false, error: 'HOLD_EXPIRED' });
});

test('locks are all released after operations finish (including failed ones)', async () => {
  const { engine } = setupWithYields(2);
  await Promise.all([
    engine.hold('1', 'A', 60),
    engine.hold('1', 'B', 60),
    engine.holdMany('C', ['1', '2']),
    engine.confirm('nope'),
  ]);

  assert.strictEqual(engine.locks.mutexes.size, 0);
});

test('lock ordering: opposite acquisition orders deadlock with raw mutexes', async () => {
  const m1 = new Mutex();
  const m2 = new Mutex();
  const finished = [];

  async function task(name, first, second) {
    await first.acquire();
    await yieldMicrotasks(2);
    await second.acquire();
    finished.push(name);
    second.release();
    first.release();
  }
  task('A', m1, m2);
  task('B', m2, m1);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(finished, []); 
});

test('lock ordering: LockManager sorts keys so opposite requests both finish', async () => {
  const locks = new LockManager();
  const finished = [];

  async function task(name, keys) {
    await locks.withLocks(keys, async () => {
      await yieldMicrotasks(2);
      finished.push(name);
    });
  }
  await Promise.all([task('A', ['seat:1', 'seat:2']), task('B', ['seat:2', 'seat:1'])]);

  assert.deepStrictEqual(finished.sort(), ['A', 'B']);
});

test('LockManager releases locks even when the critical section throws', async () => {
  const locks = new LockManager();

  await assert.rejects(locks.withLocks(['k'], async () => { throw new Error('boom'); }), /boom/);

  assert.strictEqual(locks.mutexes.size, 0);
  await locks.withLocks(['k'], async () => {}); 
});
