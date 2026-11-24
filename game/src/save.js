// Crescent Bay — saves. Three slots in versioned localStorage keys,
// one key per slot. Each slot shows mission progress (highest
// mission reached), cash and date — or "Empty". Continue loads a
// chosen slot. Autosave after each mission writes to the active
// slot; manual save from the pause menu writes to the active slot.
// A corrupt slot shows as corrupt and can be overwritten — it never
// crashes the title screen. Works with a storage shim when
// localStorage is unavailable (headless / Node smoke tests).

export const SAVE_VERSION = 1;
export const SLOT_COUNT = 3;

export function slotKey(i) {
  return 'crescent-bay-save-v1-slot-' + i;
}

function storage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (e) {}
  if (typeof window !== 'undefined' && window.__cbSaveShim) return window.__cbSaveShim;
  // In-memory shim so the module never throws without storage.
  const mem = {};
  const shim = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem(k, v) { mem[k] = String(v); },
    removeItem(k) { delete mem[k]; },
  };
  if (typeof window !== 'undefined') window.__cbSaveShim = shim;
  else if (typeof globalThis !== 'undefined') globalThis.__cbSaveShim = shim;
  return shim;
}

export function init(G) {
  const S = {
    version: SAVE_VERSION,
    slotCount: SLOT_COUNT,
    activeSlot: 0,

    // Snapshot the live game state into a plain save object.
    snapshot() {
      const m = (G && G.missions) || {};
      const p = (G && G.player) || {};
      const w = (G && G.weapons) || {};
      const highest = (typeof m.highestCompleted === 'number') ? m.highestCompleted
        : (typeof m.current === 'number' ? Math.max(0, m.current - 1)
        : (typeof m.highest === 'number' ? m.highest : 0));
      return {
        version: SAVE_VERSION,
        date: new Date().toISOString(),
        mission: highest,                 // highest mission reached
        cash: (typeof G.cash === 'number') ? G.cash : 0,
        health: (typeof p.health === 'number') ? p.health : 100,
        x: (typeof p.x === 'number') ? p.x : null,
        y: (typeof p.y === 'number') ? p.y : null,
        owned: w.owned ? Object.assign({}, w.owned) : { pistol: true, smg: true, shotgun: false },
        ammo: w.ammo ? Object.assign({}, w.ammo) : null,
        currentWeapon: w.current || 'pistol',
        timeOfDay: (G.time && typeof G.time.hour === 'number') ? G.time.hour : null,
      };
    },

    // Read one slot without throwing. Returns
    // { status: 'empty'|'ok'|'corrupt', data?, mission?, cash?, date? }
    readSlot(i) {
      if (i < 0 || i >= SLOT_COUNT) return { status: 'empty' };
      let raw = null;
      try { raw = storage().getItem(slotKey(i)); } catch (e) { return { status: 'corrupt' }; }
      if (raw === null || raw === undefined || raw === '') return { status: 'empty' };
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { return { status: 'corrupt' }; }
      if (!data || typeof data !== 'object' || data.version !== SAVE_VERSION) {
        return { status: 'corrupt' };
      }
      return {
        status: 'ok',
        data,
        mission: (typeof data.mission === 'number') ? data.mission : 0,
        cash: (typeof data.cash === 'number') ? data.cash : 0,
        date: data.date || null,
      };
    },

    // Summary for the title screen: all three slots at once.
    listSlots() {
      const out = [];
      for (let i = 0; i < SLOT_COUNT; i++) out.push(this.readSlot(i));
      return out;
    },

    saveSlot(i) {
      if (i < 0 || i >= SLOT_COUNT) return false;
      try {
        storage().setItem(slotKey(i), JSON.stringify(this.snapshot()));
        this.activeSlot = i;
        return true;
      } catch (e) { return false; }
    },

    // Manual save from the pause menu: writes the active slot.
    saveActive() { return this.saveSlot(this.activeSlot); },

    // Autosave after each mission: writes the active slot.
    autosave() { return this.saveSlot(this.activeSlot); },

    // Load a slot into the live game. Returns the data, or null.
    loadSlot(i) {
      const slot = this.readSlot(i);
      if (slot.status !== 'ok') return null;
      const d = slot.data;
      this.activeSlot = i;
      try {
        if (typeof d.cash === 'number') G.cash = d.cash;
        if (G.missions) {
          if (typeof d.mission === 'number') {
            G.missions.highestCompleted = d.mission;
            G.missions.highest = d.mission;
            // Continue starts at the next uncompleted mission.
            if (typeof G.missions.current === 'number') {
              G.missions.current = Math.min(d.mission + 1, 12);
            }
          }
        }
        if (G.player) {
          if (typeof d.health === 'number') G.player.health = d.health;
          if (typeof d.x === 'number' && typeof d.y === 'number') {
            G.player.x = d.x; G.player.y = d.y;
          }
        }
        if (G.weapons && d.owned) {
          G.weapons.owned = Object.assign({}, G.weapons.owned, d.owned);
          if (d.ammo) G.weapons.ammo = Object.assign({}, G.weapons.ammo, d.ammo);
          if (d.currentWeapon && G.weapons.owned[d.currentWeapon]) {
            G.weapons.current = d.currentWeapon;
          }
        }
        if (G.time && typeof d.timeOfDay === 'number') G.time.hour = d.timeOfDay;
      } catch (e) { /* partial apply is fine; never crash a load */ }
      return d;
    },

    // Overwrite a corrupt (or any) slot with a fresh save.
    overwriteSlot(i) { return this.saveSlot(i); },

    eraseSlot(i) {
      if (i < 0 || i >= SLOT_COUNT) return false;
      try { storage().removeItem(slotKey(i)); return true; } catch (e) { return false; }
    },
  };

  G.save = S;
  return S;
}

export function update() {}
export function draw() {}
