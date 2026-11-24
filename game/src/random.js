// Crescent Bay — deterministic RNG (mulberry32). Every random choice in
// the city (building layout, parked cars, pedestrian colours, traffic
// spawns) draws from one seeded stream so the same seed always builds the
// same city and the playtests are reproducible.

// mulberry32: a small, fast, well-tested 32-bit seeded PRNG.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A small RNG object with the helpers the game needs. next() returns a
// float in [0, 1); int / pick / range / chance build on top of it.
export function createRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    // Float in [min, max).
    range(min, max) { return min + next() * (max - min); },
    // Integer in [min, max] inclusive.
    int(min, max) { return Math.floor(min + next() * (max - min + 1)); },
    // True with probability p (0..1).
    chance(p) { return next() < p; },
    // A random element of a non-empty array.
    pick(arr) { return arr[Math.floor(next() * arr.length)]; },
    // Fisher-Yates shuffle, returns a new array.
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

export default createRng;
