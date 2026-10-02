const test = require('node:test');
const assert = require('node:assert');
const { createRng, yieldMicrotasks, setup } = require('./helpers');

const SEATS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const USERS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
const ROUNDS = 60;
const OPS_PER_ROUND = 40;

const seed = process.env.SEED ? Number(process.env.SEED) : Date.now() % 1000000;
console.log(`[stress] seed=${seed}  (reproduce with: SEED=${seed} npm run test:stress)`);

function countLiveHolds(engine, clock, userId) {
  let count = 0;
  for (const hold of engine.holds.values()) {
    if (hold.userId === userId && hold.status === 'ACTIVE' && clock.now() < hold.expiresAt) count++;
  }
  return count;
}

function checkInvariants(engine, clock, confirmedLog) {
  const soldSeats = new Set();
  for (const entry of confirmedLog) {
    assert.ok(!soldSeats.has(entry.seatId), `seat ${entry.seatId} was sold twice`);
    soldSeats.add(entry.seatId);
  }
  
  for (const [seatId, seat] of engine.seats) {
    const hold = engine.holds.get(seat.holdId);
    assert.ok(hold, `seat ${seatId} points at missing hold ${seat.holdId}`);
    assert.strictEqual(hold.seatId, seatId);
    assert.strictEqual(hold.userId, seat.userId);
    if (seat.state === 'SOLD') assert.strictEqual(hold.status, 'CONFIRMED');
    if (seat.state === 'HELD') assert.strictEqual(hold.status, 'ACTIVE');
  }

  const claimed = new Map();
  for (const hold of engine.holds.values()) {
    if (hold.status !== 'ACTIVE' && hold.status !== 'CONFIRMED') continue;
    assert.ok(!claimed.has(hold.seatId), `seat ${hold.seatId} has two claimed holds`);
    claimed.set(hold.seatId, hold);
    assert.strictEqual(engine.seats.get(hold.seatId).holdId, hold.holdId);
  }
  assert.strictEqual(claimed.size, engine.seats.size);

  let activeCount = 0;
  for (const hold of engine.holds.values()) {
    const inUserSet = engine.userHolds.get(hold.userId)?.has(hold.holdId) ?? false;
    assert.strictEqual(inUserSet, hold.status === 'ACTIVE', `userHolds mismatch for ${hold.holdId}`);
    if (hold.status === 'ACTIVE') activeCount++;
  }
  const totalInUserSets = [...engine.userHolds.values()].reduce((sum, set) => sum + set.size, 0);
  assert.strictEqual(totalInUserSets, activeCount);

  for (const userId of USERS) {
    assert.ok(countLiveHolds(engine, clock, userId) <= 4, `${userId} has more than 4 live holds`);
  }

  for (const entry of confirmedLog) {
    const hold = engine.holds.get(entry.holdId);
    assert.ok(hold.confirmedAt < hold.expiresAt, `hold ${hold.holdId} was confirmed after expiry`);
    assert.deepStrictEqual(engine.seatStatus(entry.seatId), { status: 'SOLD', user: entry.userId });
  }
}

test('stress: many overlapping hold/holdMany/confirm/release operations keep the engine consistent', async () => {
  const rng = createRng(seed);
  const { engine, clock } = setup({ io: () => yieldMicrotasks(rng.int(0, 3)) });
  const knownHoldIds = [];
  const confirmedLog = [];
  const stats = { holds: 0, holdManys: 0, confirms: 0, releases: 0, failures: 0 };

  function remember(result) {
    if (result.holdId) knownHoldIds.push(result.holdId);
    if (result.holdIds) knownHoldIds.push(...result.holdIds);
  }

  function afterOp(userId) {
    assert.ok(countLiveHolds(engine, clock, userId) <= 4, `${userId} exceeded 4 live holds mid-run`);
  }

  async function randomOperation() {
    const kind = rng.next();
    const userId = rng.pick(USERS);

    if (kind < 0.4) {
      const result = await engine.hold(rng.pick(SEATS), userId, rng.int(5, 40));
      remember(result);
      result.ok ? stats.holds++ : stats.failures++;
      afterOp(userId);
    } else if (kind < 0.57) {
      const seatIds = Array.from({ length: rng.int(1, 3) }, () => rng.pick(SEATS));
      const result = await engine.holdMany(userId, seatIds, rng.int(5, 40));
      remember(result);
      result.ok ? stats.holdManys++ : stats.failures++;
      afterOp(userId);
    } else if (kind < 0.65) {
      const holdId = knownHoldIds.length > 0 ? rng.pick(knownHoldIds) : 'none';
      const result = await engine.confirm(holdId);
      if (result.ok) {
        const hold = engine.holds.get(holdId);
        confirmedLog.push({ holdId, seatId: hold.seatId, userId: hold.userId });
        stats.confirms++;
      } else {
        stats.failures++;
      }
    } else if (kind < 0.8) {
      const holdId = knownHoldIds.length > 0 ? rng.pick(knownHoldIds) : 'none';
      const result = await engine.release(holdId);
      result.ok ? stats.releases++ : stats.failures++;
    } else {
      await yieldMicrotasks(rng.int(0, 3));
      clock.advance(rng.int(1, 15));
    }
  }

  for (let round = 0; round < ROUNDS; round++) {
    const tasks = [];
    for (let i = 0; i < OPS_PER_ROUND; i++) tasks.push(randomOperation());
    await Promise.all(tasks); 
    checkInvariants(engine, clock, confirmedLog);
  }

  console.log(`[stress] seed=${seed} stats=${JSON.stringify(stats)} sold=${confirmedLog.length}`);
  assert.ok(stats.holds + stats.holdManys > 0, 'stress run created no holds');
  assert.ok(stats.confirms > 0, 'stress run confirmed nothing');
  assert.strictEqual(engine.locks.mutexes.size, 0, 'locks leaked');
});
