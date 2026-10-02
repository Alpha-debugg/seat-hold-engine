# Bugs I Fear

## 1. Missing lock in a future operation

**Bug:** If a new operation is added and does not use the same locking mechanism, it could introduce a race condition.

**Why tests might miss it:** The current tests only cover the operations implemented in this version.

**How to detect it:** Add the new operation to the concurrency tests and keep checking the engine's state invariants.

## 2. Moving from memory to a database

**Bug:** `holdMany()` is atomic with in-memory Maps, but moving to a database would require a real transaction. A failure between database writes could leave inconsistent state.

**Why tests might miss it:** The current implementation does not have database failures.

**How to detect it:** Use database transactions and add tests for partial write/failure scenarios.

## 3. Clock issues

**Bug:** The production clock uses `Date.now()`. A system clock change could affect when holds expire.

**Why tests might miss it:** Tests use a controlled `FakeClock`.

**How to detect it:** Monitor clock changes and use a consistent time source if the system becomes distributed.

## 4. Memory growth

**Bug:** Finished holds remain in the `holds` Map, which could cause memory usage to grow over time.

**Why tests might miss it:** Short test runs won't show long-term memory growth.

**How to detect it:** Monitor memory usage and periodically clean up old completed holds.