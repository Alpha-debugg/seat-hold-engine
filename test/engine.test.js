const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers');


test('1. holding a free seat', async () => {
  const { engine } = setup();

  const result = await engine.hold('1', 'A', 60);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(typeof result.holdId, 'string');
  assert.deepStrictEqual(engine.seatStatus('1'), { status: 'HELD', user: 'A', expiresAt: 60000 });
});

test('2. holding a seat that another user holds fails', async () => {
  const { engine } = setup();
  await engine.hold('1', 'A', 60);

  const result = await engine.hold('1', 'B', 60);

  assert.deepStrictEqual(result, { ok: false, error: 'SEAT_HELD', seatId: '1' });
  assert.strictEqual(engine.seatStatus('1').user, 'A');
});

test('3. same user holding the same seat twice is an idempotent retry and never extends the hold (R4/R5)', async () => {
  const { engine, clock } = setup();
  const first = await engine.hold('1', 'A', 60);
  clock.advance(30);

  const second = await engine.hold('1', 'A', 600); 

  assert.strictEqual(second.holdId, first.holdId);
  assert.strictEqual(engine.seatStatus('1').expiresAt, 60000);
  assert.strictEqual(engine.holds.size, 1);
});

test('4. confirming a valid hold sells the seat', async () => {
  const { engine } = setup();
  const { holdId } = await engine.hold('1', 'A', 60);

  assert.deepStrictEqual(await engine.confirm(holdId), { ok: true });

  assert.deepStrictEqual(engine.seatStatus('1'), { status: 'SOLD', user: 'A' });
});

test('5. releasing a valid hold frees the seat for others', async () => {
  const { engine } = setup();
  const { holdId } = await engine.hold('1', 'A', 60);

  assert.deepStrictEqual(await engine.release(holdId), { ok: true });

  assert.deepStrictEqual(engine.seatStatus('1'), { status: 'FREE' });
  assert.ok((await engine.hold('1', 'B', 60)).ok);
});

test('6. invalid hold id', async () => {
  const { engine } = setup();

  assert.deepStrictEqual(await engine.confirm('nope'), { ok: false, error: 'HOLD_NOT_FOUND' });
  assert.deepStrictEqual(await engine.release('nope'), { ok: false, error: 'HOLD_NOT_FOUND' });
});

test('7. an expired hold shows the seat as FREE', async () => {
  const { engine, clock } = setup();
  await engine.hold('1', 'A', 60);

  clock.advance(59);
  assert.strictEqual(engine.seatStatus('1').status, 'HELD');
  clock.advance(2);
  assert.deepStrictEqual(engine.seatStatus('1'), { status: 'FREE' });
});

test('7b. hold is expired at exactly expiresAt', async () => {
  const { engine, clock } = setup();
  await engine.hold('1', 'A', 60);

  clock.advance(60);

  assert.strictEqual(engine.seatStatus('1').status, 'FREE');
});

test('8. confirming an expired hold fails even when nobody took the seat (R3)', async () => {
  const { engine, clock } = setup();
  const { holdId } = await engine.hold('1', 'A', 60);
  clock.advance(61);

  const result = await engine.confirm(holdId);

  assert.deepStrictEqual(result, { ok: false, error: 'HOLD_EXPIRED' });
  assert.strictEqual(engine.seatStatus('1').status, 'FREE');
});

test('9. a user cannot hold more than 4 seats (R2)', async () => {
  const { engine } = setup();
  for (const seatId of ['1', '2', '3', '4']) {
    assert.ok((await engine.hold(seatId, 'A', 60)).ok);
  }

  const result = await engine.hold('5', 'A', 60);

  assert.deepStrictEqual(result, { ok: false, error: 'LIMIT_EXCEEDED' });
  assert.strictEqual(engine.seatStatus('5').status, 'FREE');
  assert.ok((await engine.hold('5', 'B', 60)).ok); 
});

test('9b. releasing a hold makes room under the limit again', async () => {
  const { engine } = setup();
  const holds = [];
  for (const seatId of ['1', '2', '3', '4']) holds.push(await engine.hold(seatId, 'A', 60));

  await engine.release(holds[0].holdId);

  assert.ok((await engine.hold('5', 'A', 60)).ok);
});

test('10. holdMany success holds every seat', async () => {
  const { engine } = setup();

  const result = await engine.holdMany('A', ['1', '2', '3']);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.holdIds.length, 3);
  for (const seatId of ['1', '2', '3']) {
    assert.strictEqual(engine.seatStatus(seatId).user, 'A');
  }
});

test('11. holdMany fails when one seat is unavailable', async () => {
  const { engine } = setup();
  await engine.hold('2', 'B', 60);

  const result = await engine.holdMany('A', ['1', '2', '3']);

  assert.deepStrictEqual(result, { ok: false, error: 'SEAT_HELD', seatId: '2' });
});

test('12. a failed holdMany leaves zero seats held', async () => {
  const { engine } = setup();
  await engine.hold('3', 'B', 60);
  const holdsBefore = engine.holds.size;

  await engine.holdMany('A', ['1', '2', '3']);

  assert.strictEqual(engine.seatStatus('1').status, 'FREE');
  assert.strictEqual(engine.seatStatus('2').status, 'FREE');
  assert.strictEqual(engine.holds.size, holdsBefore);
  assert.strictEqual(engine.userHolds.has('A'), false);
  assert.ok((await engine.holdMany('A', ['1', '2', '4', '5'])).ok);
});

test('13. confirming a sold seat / a confirmed hold fails, and a sold seat cannot be held or released', async () => {
  const { engine } = setup();
  const { holdId } = await engine.hold('1', 'A', 60);
  await engine.confirm(holdId);

  assert.deepStrictEqual(await engine.confirm(holdId), { ok: false, error: 'ALREADY_CONFIRMED' });
  assert.deepStrictEqual(await engine.release(holdId), { ok: false, error: 'ALREADY_CONFIRMED' });
  assert.deepStrictEqual(await engine.hold('1', 'B', 60), { ok: false, error: 'SEAT_SOLD', seatId: '1' });
  assert.deepStrictEqual(await engine.hold('1', 'A', 60), { ok: false, error: 'SEAT_SOLD', seatId: '1' });
  assert.deepStrictEqual(engine.seatStatus('1'), { status: 'SOLD', user: 'A' });
});

test('14. releasing an already-released hold fails', async () => {
  const { engine } = setup();
  const { holdId } = await engine.hold('1', 'A', 60);
  await engine.release(holdId);

  assert.deepStrictEqual(await engine.release(holdId), { ok: false, error: 'HOLD_RELEASED' });
  assert.deepStrictEqual(await engine.confirm(holdId), { ok: false, error: 'HOLD_RELEASED' });
});

test('14b. releasing an expired hold fails', async () => {
  const { engine, clock } = setup();
  const { holdId } = await engine.hold('1', 'A', 60);
  clock.advance(61);

  assert.deepStrictEqual(await engine.release(holdId), { ok: false, error: 'HOLD_EXPIRED' });
});

test('15. expired seat can be taken by another user, and the old holder cannot confirm', async () => {
  const { engine, clock } = setup();
  const oldHold = await engine.hold('1', 'A', 60);
  clock.advance(61);

  const newHold = await engine.hold('1', 'B', 60);
  assert.ok(newHold.ok);

  assert.deepStrictEqual(await engine.confirm(oldHold.holdId), { ok: false, error: 'HOLD_EXPIRED' });
  assert.deepStrictEqual(engine.seatStatus('1'), { status: 'HELD', user: 'B', expiresAt: 121000 });
  assert.ok((await engine.confirm(newHold.holdId)).ok);
});


test('16a. same user holding again after expiry gets a new hold; the old holdId stays dead', async () => {
  const { engine, clock } = setup();
  const oldHold = await engine.hold('1', 'A', 60);
  clock.advance(100);

  const newHold = await engine.hold('1', 'A', 60);

  assert.ok(newHold.ok);
  assert.notStrictEqual(newHold.holdId, oldHold.holdId);
  assert.strictEqual(engine.seatStatus('1').expiresAt, 160000);
  assert.deepStrictEqual(await engine.confirm(oldHold.holdId), { ok: false, error: 'HOLD_EXPIRED' });
});

test('16b. an idempotent retry does not extend: the hold still expires at the original time', async () => {
  const { engine, clock } = setup();
  await engine.hold('1', 'A', 60);
  clock.advance(50);
  await engine.hold('1', 'A', 60);
  clock.advance(10);

  assert.strictEqual(engine.seatStatus('1').status, 'FREE');
});

test('16c. a confirmed hold cannot be taken after its original TTL passes', async () => {
  const { engine, clock } = setup();
  const { holdId } = await engine.hold('1', 'A', 60);
  await engine.confirm(holdId);
  clock.advance(1000);

  assert.deepStrictEqual(engine.seatStatus('1'), { status: 'SOLD', user: 'A' });
  assert.strictEqual((await engine.hold('1', 'B', 60)).error, 'SEAT_SOLD');
});


test('16d. holdMany counts already-held seats once (R2/R6)', async () => {
  const { engine } = setup();
  const first = await engine.holdMany('A', ['1', '2']);

  const result = await engine.holdMany('A', ['1', '2', '3', '4']); 

  assert.ok(result.ok);
  assert.deepStrictEqual(result.holdIds.slice(0, 2), first.holdIds); 
  assert.strictEqual(engine.userHolds.get('A').size, 4);
});

test('16e. holdMany over the limit fails and holds nothing (R2/R6)', async () => {
  const { engine } = setup();
  await engine.holdMany('A', ['1', '2']);

  const result = await engine.holdMany('A', ['3', '4', '5']); 

  assert.deepStrictEqual(result, { ok: false, error: 'LIMIT_EXCEEDED' });
  for (const seatId of ['3', '4', '5']) assert.strictEqual(engine.seatStatus(seatId).status, 'FREE');
  assert.strictEqual(engine.userHolds.get('A').size, 2);

  assert.strictEqual((await engine.holdMany('B', ['6', '7', '8', '9', '10'])).error, 'LIMIT_EXCEEDED');
});

test('16f. expired holds and sold seats do not count toward the limit', async () => {
  const { engine, clock } = setup();
  const sold = await engine.hold('1', 'A', 60);
  await engine.confirm(sold.holdId);
  await engine.hold('2', 'A', 60);
  await engine.hold('3', 'A', 60);
  clock.advance(61); 

  const result = await engine.holdMany('A', ['4', '5', '6', '7']);

  assert.ok(result.ok);
});

test('16g. holdMany reports seat errors before limit errors', async () => {
  const { engine } = setup();
  await engine.hold('9', 'B', 60);

  const result = await engine.holdMany('A', ['1', '2', '3', '4', '9']);

  assert.deepStrictEqual(result, { ok: false, error: 'SEAT_HELD', seatId: '9' });
});

test('16h. holdMany ignores duplicate seat ids in the request', async () => {
  const { engine } = setup();

  const result = await engine.holdMany('A', ['1', '1', '2', '1']);

  assert.ok(result.ok);
  assert.strictEqual(result.holdIds.length, 2);
});

test('16i. expired seat in a holdMany is taken over cleanly', async () => {
  const { engine, clock } = setup();
  const old = await engine.hold('2', 'B', 60);
  clock.advance(61);

  const result = await engine.holdMany('A', ['1', '2']);

  assert.ok(result.ok);
  assert.strictEqual(engine.holds.get(old.holdId).status, 'EXPIRED');
  assert.strictEqual(engine.userHolds.has('B'), false);
});


test('invalid arguments are rejected', async () => {
  const { engine } = setup();

  assert.strictEqual((await engine.hold('', 'A', 60)).error, 'INVALID_ARGUMENT');
  assert.strictEqual((await engine.hold('1', '', 60)).error, 'INVALID_ARGUMENT');
  assert.strictEqual((await engine.hold('1', 'A', 0)).error, 'INVALID_ARGUMENT');
  assert.strictEqual((await engine.hold('1', 'A', -5)).error, 'INVALID_ARGUMENT');
  assert.strictEqual((await engine.hold('1', 'A', NaN)).error, 'INVALID_ARGUMENT');
  assert.strictEqual((await engine.holdMany('A', [])).error, 'INVALID_ARGUMENT');
  assert.strictEqual((await engine.holdMany('A', 'nope')).error, 'INVALID_ARGUMENT');
  assert.strictEqual((await engine.holdMany('A', ['1', 2])).error, 'INVALID_ARGUMENT');
  assert.strictEqual(engine.holds.size, 0);
});

test('FakeClock only moves when advanced', () => {
  const { clock } = setup();

  assert.strictEqual(clock.now(), 0);
  clock.advance(1.5);
  assert.strictEqual(clock.now(), 1500);
});
