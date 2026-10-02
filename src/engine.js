const { Clock } = require('./clock');
const { LockManager } = require('./locks');

const MAX_ACTIVE_HOLDS = 4;
const DEFAULT_TTL_SECONDS = 300;

function fail(error, seatId) {
  const result = { ok: false, error };
  if (seatId !== undefined) result.seatId = seatId;
  return result;
}

function isValidId(value) {
  return typeof value === 'string' && value.length > 0;
}

class SeatHoldEngine {
  constructor(options = {}) {
    this.clock = options.clock || new Clock();
    this.locks = options.locks || new LockManager();
    this.io = options.io || (async () => {});
    this.defaultTtlSeconds = options.defaultTtlSeconds || DEFAULT_TTL_SECONDS;

    this.seats = new Map(); 
    this.holds = new Map(); 
    this.userHolds = new Map(); 
    this.nextHoldNumber = 1;
  }


  async hold(seatId, userId, ttlSeconds) {
    const result = await this.holdSeats(userId, [seatId], ttlSeconds);
    if (!result.ok) return result;
    return { ok: true, holdId: result.holdIds[0] };
  }

  async holdMany(userId, seatIds, ttlSeconds = this.defaultTtlSeconds) {
    return this.holdSeats(userId, seatIds, ttlSeconds);
  }

  async confirm(holdId) {
    const hold = this.holds.get(holdId);
    if (!hold) return fail('HOLD_NOT_FOUND');

    return this.locks.withLocks([`seat:${hold.seatId}`], async () => {
      const now = this.clock.now();
      const error = this.holdError(hold, now);
      if (error) return fail(error);

      await this.io();

      hold.status = 'CONFIRMED';
      hold.confirmedAt = now;
      this.removeFromUser(hold);
      this.seats.set(hold.seatId, { state: 'SOLD', userId: hold.userId, holdId });
      return { ok: true };
    });
  }

  async release(holdId) {
    const hold = this.holds.get(holdId);
    if (!hold) return fail('HOLD_NOT_FOUND');

    return this.locks.withLocks([`seat:${hold.seatId}`], async () => {
      const now = this.clock.now();
      const error = this.holdError(hold, now);
      if (error) return fail(error);

      await this.io();

      hold.status = 'RELEASED';
      this.removeFromUser(hold);
      this.seats.delete(hold.seatId);
      return { ok: true };
    });
  }

  seatStatus(seatId) {
    const seat = this.seats.get(seatId);
    if (!seat) return { status: 'FREE' };
    if (seat.state === 'SOLD') return { status: 'SOLD', user: seat.userId };

    const hold = this.holds.get(seat.holdId);
    if (this.clock.now() >= hold.expiresAt) return { status: 'FREE' };
    return { status: 'HELD', user: seat.userId, expiresAt: hold.expiresAt };
  }

  async holdSeats(userId, seatIds, ttlSeconds) {
    const validTtl = typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0;
    if (!isValidId(userId) || !validTtl) return fail('INVALID_ARGUMENT');
    if (!Array.isArray(seatIds) || seatIds.length === 0 || !seatIds.every(isValidId)) {
      return fail('INVALID_ARGUMENT');
    }

    const uniqueSeatIds = [...new Set(seatIds)];
    const keys = [`user:${userId}`, ...uniqueSeatIds.map((id) => `seat:${id}`)];

    return this.locks.withLocks(keys, async () => {
      const now = this.clock.now();

      const plan = [];
      let newSeatCount = 0;
      for (const seatId of uniqueSeatIds) {
        const info = this.inspectSeat(seatId, userId, now);
        if (info.kind === 'SOLD') return fail('SEAT_SOLD', seatId);
        if (info.kind === 'TAKEN') return fail('SEAT_HELD', seatId);
        if (info.kind === 'FREE') newSeatCount++;
        plan.push({ seatId, info });
      }
      if (this.countLiveHolds(userId, now) + newSeatCount > MAX_ACTIVE_HOLDS) {
        return fail('LIMIT_EXCEEDED');
      }

      await this.io();

      const holdIds = plan.map(({ seatId, info }) => {
        if (info.kind === 'OWN') return info.hold.holdId; 
        if (info.staleHold) this.expireHold(info.staleHold);
        return this.createHold(seatId, userId, ttlSeconds, now);
      });
      return { ok: true, holdIds };
    });
  }

  inspectSeat(seatId, userId, now) {
    const seat = this.seats.get(seatId);
    if (!seat) return { kind: 'FREE' };
    if (seat.state === 'SOLD') return { kind: 'SOLD' };

    const hold = this.holds.get(seat.holdId);
    if (now >= hold.expiresAt) return { kind: 'FREE', staleHold: hold };
    if (hold.userId === userId) return { kind: 'OWN', hold };
    return { kind: 'TAKEN' };
  }

  countLiveHolds(userId, now) {
    const holdIds = this.userHolds.get(userId);
    if (!holdIds) return 0;
    let count = 0;
    for (const holdId of holdIds) {
      if (now < this.holds.get(holdId).expiresAt) count++;
    }
    return count;
  }

  createHold(seatId, userId, ttlSeconds, now) {
    const holdId = `h${this.nextHoldNumber++}`;
    const hold = {
      holdId,
      seatId,
      userId,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      status: 'ACTIVE',
      confirmedAt: null,
    };
    this.holds.set(holdId, hold);
    this.seats.set(seatId, { state: 'HELD', userId, holdId });
    if (!this.userHolds.has(userId)) this.userHolds.set(userId, new Set());
    this.userHolds.get(userId).add(holdId);
    return holdId;
  }

  expireHold(hold) {
    hold.status = 'EXPIRED';
    this.removeFromUser(hold);
    const seat = this.seats.get(hold.seatId);
    if (seat && seat.holdId === hold.holdId) this.seats.delete(hold.seatId);
  }

  removeFromUser(hold) {
    const holdIds = this.userHolds.get(hold.userId);
    if (!holdIds) return;
    holdIds.delete(hold.holdId);
    if (holdIds.size === 0) this.userHolds.delete(hold.userId);
  }

  holdError(hold, now) {
    if (hold.status === 'CONFIRMED') return 'ALREADY_CONFIRMED';
    if (hold.status === 'RELEASED') return 'HOLD_RELEASED';
    if (hold.status === 'EXPIRED') return 'HOLD_EXPIRED';
    if (now >= hold.expiresAt) {
      this.expireHold(hold);
      return 'HOLD_EXPIRED';
    }
    return null;
  }
}

module.exports = { SeatHoldEngine, MAX_ACTIVE_HOLDS };
