# Decisions

Test references are written as `file :: test name`.  
Run all tests with:

```bash
npm test
```

## 1. R3 / R4 / R5 — Expiry and Retry

**Ambiguity:**  
R3 says a hold expires after its TTL, R4 says holds cannot be extended, and R5 says the same-user retry should be idempotent.

**Decision:**
- A hold expires when `now >= expiresAt`.
- An expired hold cannot be confirmed.
- If the same user retries while the hold is active, the same `holdId` is returned.
- A retry never changes the original expiry time.
- After expiry, a new hold creates a new `holdId`.

**Why:**  
This keeps the retry idempotent without allowing it to extend the hold.

**Tests:**  
Expiry, expired confirmation, same-user retry, and retry after expiry are covered in `engine.test.js`.

---

## 2. R2 / R6 — Four-Seat Limit and `holdMany()`

**Ambiguity:**  
A user can have at most 4 active holds, while `holdMany()` must be all-or-nothing.

**Decision:**  
If the complete `holdMany()` request would take the user over 4 active seats, the whole request fails.

No partial holds are created.

If a requested seat is already actively held by the same user, it is treated as an idempotent retry.

**Why:**  
This keeps the 4-seat limit while preserving `holdMany()` atomicity.

---

## 3. Expiration Strategy

**Decision:**  
Use lazy expiration instead of background timers.

The engine checks the hold's `expiresAt` when the seat or hold is accessed.

**Why:**  
It keeps the implementation simple and avoids background timer management.

---

## 4. Clock

**Decision:**  
The clock is injectable.

Production code uses the system clock, while tests use `FakeClock`.

```js
clock.advance(60);
```

moves test time forward without waiting in real time.

**Why:**  
This makes expiration tests fast and deterministic.

---

## 5. Concurrency

**Decision:**  
Use mutexes to protect operations that read and modify shared state.

JavaScript is single-threaded, but asynchronous operations can still overlap when they reach an `await`. Therefore, check-and-update operations need synchronization.

**Why:**  
This prevents race conditions such as two users successfully holding the same seat or bypassing the 4-seat limit.

---

## 6. `holdMany()` Atomicity

**Decision:**  

`holdMany()` first validates the complete request:

1. Check the requested seats.
2. Check the user's active-hold limit.
3. Only if everything is valid, create the holds.

If validation fails, no seats are changed.

**Why:**  
This prevents partial holds.

---

## 7. Lock Ordering

**Decision:**  
When multiple seats need to be locked, their IDs are sorted before acquiring locks.

Example:

```text
["3", "1", "2"]
        ↓
["1", "2", "3"]
```

**Why:**  
Using the same lock order prevents competing `holdMany()` operations from waiting on each other in opposite orders.

---

## Other Assumptions

- Seat IDs are non-empty strings.
- The engine is in-memory and process-local.
- Business errors are returned instead of being thrown.
- Confirmed seats cannot be released.
- Holds are never extended.
- Expired holds become available again.