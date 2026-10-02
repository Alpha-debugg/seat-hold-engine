class Mutex {
  constructor() {
    this.locked = false;
    this.waiters = [];
  }

  acquire() {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next(); 
    } else {
      this.locked = false;
    }
  }

  isIdle() {
    return !this.locked && this.waiters.length === 0;
  }
}

class LockManager {
  constructor() {
    this.mutexes = new Map();
  }

  async acquire(key) {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.mutexes.set(key, mutex);
    }
    await mutex.acquire();
  }

  release(key) {
    const mutex = this.mutexes.get(key);
    mutex.release();
    if (mutex.isIdle()) {
      this.mutexes.delete(key);
    }
  }

  async withLocks(keys, fn) {
    const sortedKeys = [...new Set(keys)].sort();
    const acquired = [];
    try {
      for (const key of sortedKeys) {
        await this.acquire(key);
        acquired.push(key);
      }
      return await fn();
    } finally {
      for (const key of acquired.reverse()) {
        this.release(key);
      }
    }
  }
}

module.exports = { Mutex, LockManager };
