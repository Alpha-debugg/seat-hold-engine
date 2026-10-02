const { SeatHoldEngine } = require('../src/engine');
const { FakeClock } = require('../src/clock');

function createRng(seed) {
  let state = seed >>> 0;
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(list) {
      return list[Math.floor(next() * list.length)];
    },
  };
}

async function yieldMicrotasks(n) {
  for (let i = 0; i < n; i++) await null;
}

function setup(options = {}) {
  const clock = new FakeClock(0);
  const engine = new SeatHoldEngine({ clock, ...options });
  return { clock, engine };
}

module.exports = { createRng, yieldMicrotasks, setup };
