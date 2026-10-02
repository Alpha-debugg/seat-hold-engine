const test = require('node:test');
const assert = require('node:assert');
const { createRng, setup } = require('./helpers');

const SEATS = ['1', '2', '3', '4', '5', '6'];
const USERS = ['u1', 'u2', 'u3'];
const OPERATIONS_PER_RUN = 300;
const DEFAULT_TTL = 300;

class ReferenceModel {
  constructor() {
    this.nowMs = 0;
    this.holds = []; 
  }

  advance(seconds) {
    this.nowMs += seconds * 1000;
  }

  isLive(hold) {
    return hold.state === 'ACTIVE' && this.nowMs < hold.expiresAt;
  }

  seatStatus(seat) {
    for (const hold of this.holds) {
      if (hold.seat === seat && hold.state === 'CONFIRMED') return { status: 'SOLD', user: hold.user };
    }
    for (const hold of this.holds) {
      if (hold.seat === seat && this.isLive(hold)) {
        return { status: 'HELD', user: hold.user, expiresAt: hold.expiresAt };
      }
    }
    return { status: 'FREE' };
  }

  holdMany(user, seats, ttl) {
    const wanted = seats.filter((seat, index) => seats.indexOf(seat) === index);
    const newSeats = [];
    for (const seat of wanted) {
      const status = this.seatStatus(seat);
      if (status.status === 'SOLD') return { ok: false, error: 'SEAT_SOLD', seatId: seat };
      if (status.status === 'HELD' && status.user !== user) return { ok: false, error: 'SEAT_HELD', seatId: seat };
      if (status.status === 'FREE') newSeats.push(seat);
    }
    const liveCount = this.holds.filter((hold) => hold.user === user && this.isLive(hold)).length;
    if (liveCount + newSeats.length > 4) return { ok: false, error: 'LIMIT_EXCEEDED' };

    const ids = wanted.map((seat) => {
      const existing = this.holds.find((hold) => hold.seat === seat && hold.user === user && this.isLive(hold));
      if (existing) return existing.id;
      const hold = { id: `m${this.holds.length + 1}`, seat, user, expiresAt: this.nowMs + ttl * 1000, state: 'ACTIVE' };
      this.holds.push(hold);
      return hold.id;
    });
    return { ok: true, ids };
  }

  change(id, newState) {
    const hold = this.holds.find((h) => h.id === id);
    if (!hold) return { ok: false, error: 'HOLD_NOT_FOUND' };
    if (hold.state === 'CONFIRMED') return { ok: false, error: 'ALREADY_CONFIRMED' };
    if (hold.state === 'RELEASED') return { ok: false, error: 'HOLD_RELEASED' };
    if (!this.isLive(hold)) return { ok: false, error: 'HOLD_EXPIRED' };
    hold.state = newState;
    return { ok: true };
  }
}

function runSequence(seed, operationCount) {
  return async () => {
    console.log(`[model] seed=${seed}`);
    const rng = createRng(seed);
    const { engine, clock } = setup();
    const model = new ReferenceModel();
    const engineToModelId = new Map();
    const pairs = []; 

    function link(engineIds, modelIds) {
      engineIds.forEach((engineId, i) => {
        if (!engineToModelId.has(engineId)) {
          engineToModelId.set(engineId, modelIds[i]);
          pairs.push([engineId, modelIds[i]]);
        }
      });
    }

    for (let step = 0; step < operationCount; step++) {
      const kind = rng.next();
      let label;
      let actual;
      let expected;

      if (kind < 0.35) {
        const seat = rng.pick(SEATS);
        const user = rng.pick(USERS);
        const ttl = rng.int(5, 60);
        label = `hold(${seat}, ${user}, ${ttl})`;
        actual = await engine.hold(seat, user, ttl);
        expected = model.holdMany(user, [seat], ttl);
        if (actual.ok && expected.ok) link([actual.holdId], expected.ids);
        if (actual.ok) actual = { ok: true };
        if (expected.ok) expected = { ok: true };
      } else if (kind < 0.5) {
        const user = rng.pick(USERS);
        const seats = Array.from({ length: rng.int(1, 5) }, () => rng.pick(SEATS));
        label = `holdMany(${user}, [${seats}])`;
        actual = await engine.holdMany(user, seats, DEFAULT_TTL);
        expected = model.holdMany(user, seats, DEFAULT_TTL);
        if (actual.ok && expected.ok) link(actual.holdIds, expected.ids);
        if (actual.ok) actual = { ok: true };
        if (expected.ok) expected = { ok: true };
      } else if (kind < 0.7 || kind < 0.85) {
        const isConfirm = kind < 0.7;
        const pair = pairs.length > 0 && rng.next() < 0.95 ? rng.pick(pairs) : ['bogus', 'bogus'];
        label = `${isConfirm ? 'confirm' : 'release'}(${pair[0]})`;
        actual = await (isConfirm ? engine.confirm(pair[0]) : engine.release(pair[0]));
        expected = model.change(pair[1], isConfirm ? 'CONFIRMED' : 'RELEASED');
      } else {
        const seconds = rng.int(1, 40);
        label = `advance(${seconds})`;
        clock.advance(seconds);
        model.advance(seconds);
        actual = expected = { ok: true };
      }

      assert.deepStrictEqual(actual, expected, `seed ${seed}, step ${step}: ${label}`);
      for (const seat of SEATS) {
        assert.deepStrictEqual(
          engine.seatStatus(seat),
          model.seatStatus(seat),
          `seed ${seed}, step ${step}: seat ${seat} differs after ${label}`
        );
      }
    }
  };
}

const seeds = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: 30 }, (_, i) => i + 1);
for (const seed of seeds) {
  test(`model: engine matches reference model (seed ${seed})`, runSequence(seed, OPERATIONS_PER_RUN));
}
