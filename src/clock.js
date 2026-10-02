class Clock {
  now() {
    return Date.now();
  }
}


class FakeClock {
  constructor(startMs = 0) {
    this.currentMs = startMs;
  }

  now() {
    return this.currentMs;
  }

  advance(seconds) {
    this.currentMs += seconds * 1000;
  }
}

module.exports = { Clock, FakeClock };
