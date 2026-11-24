// shots.js — screenshot poses for "Crescent Bay" (spec §5).
//
// The game is photographed in four poses, all at deterministic seed 7:
//   cover   — bright daytime, waterfront, chase, wanted 3, escape objective
//   mission — on foot, shootout, fixer dialog visible
//   night   — night chase, headlights, roadblock, wanted 4
//   start   — title overlay over the living city
//
// A pose is staged only through the game's own systems: it starts a
// real mission, sets real heat, puts Rook on a real road, and lets the
// autopilot drive. Nothing fake is ever drawn into the frame. When the
// pose's conditions hold, the module raises window.__shotReady and the
// screenshot tool takes the shot.
//
// How a pose is requested: the URL (?shot= / ?pose=, plus ?mission=,
// ?wanted=, ?time=, ?autopilot=) or the hook the screenshot tool calls
// (window.__stagePose, also reachable as G.shots.stagePose and
// G.stagePose). The poses are data, not branches: POSE_DEFS holds one
// row per pose (mission, wanted level, hour, Rook's spot, whether the
// autopilot drives), and one staging flow reads the row.
//
// Contract: ES module. init(G), update(G, dt), draw(G, ctx). State
// lives on G.shots. Defensive throughout: the module is a no-op when
// no pose is staged (normal play), and every optional field is guarded.

// Mission id -> index in the mission list (m1 is index 0).
const MISSION_INDEX = {
  m1: 0, m2: 1, m3: 2, m4: 3, m5: 4, m6: 5,
  m7: 6, m8: 7, m9: 8, m10: 9, m11: 10, m12: 11,
};

// Heat that produces a given wanted level. Wanted thresholds are
// [0, 12, 30, 52, 74, 92]; m7's scripted cover heat is 58, m12's 74.
const HEAT_FOR_WANTED = { 1: 12, 2: 30, 3: 58, 4: 74, 5: 92 };
const WANTED_STEPS = [0, 12, 30, 52, 74, 92];

// One row per pose. `spot` is where Rook stands when the pose opens,
// `hour` the time of day, `drive` whether the autopilot takes the
// wheel (the mission pose keeps it off: it would press E and accept
// the dialog before the shot is taken).
const POSE_DEFS = {
  cover: { mission: 'm7', wanted: 3, hour: 12, spot: { x: 2800, y: 1800 }, drive: true },
  night: { mission: 'm7', wanted: 4, hour: 22, spot: { x: 2800, y: 1800 }, drive: true },
  mission: { mission: 'm8', wanted: 0, hour: 12, spot: { x: 1800, y: 1500 }, drive: false },
  start: { mission: null, wanted: 0, hour: 12, spot: null, drive: false },
};
const POSE_NAMES = Object.keys(POSE_DEFS);

function num(v, dflt) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function normalizePose(name) {
  if (!name) return null;
  // The tool passes file-style names ("1-cover"); strip the prefix.
  const n = String(name).trim().toLowerCase().replace(/^\d+-/, '');
  if (n === '1' || n === '2' || n === '3' || n === '4') return null;
  return POSE_NAMES.indexOf(n) >= 0 ? n : null;
}

function readParams() {
  const out = {};
  try {
    if (typeof window === 'undefined' || !window.location) return out;
    const q = new URLSearchParams(window.location.search || '');
    const pose = normalizePose(q.get('pose') || q.get('shot'));
    if (pose) out.pose = pose;
    const mission = (q.get('mission') || '').trim().toLowerCase();
    if (MISSION_INDEX[mission] !== undefined) out.mission = mission;
    const wanted = parseInt(q.get('wanted') || '', 10);
    if (wanted >= 1 && wanted <= 5) out.wanted = wanted;
    const time = (q.get('time') || '').trim().toLowerCase();
    if (time === 'night' || time === 'day') out.time = time;
    if (q.get('autopilot') === '1' || q.get('autopilot') === 'true') out.autopilot = true;
  } catch (e) { /* no URL (Node smoke test) — plain play, no pose */ }
  return out;
}

function hideOverlays() {
  if (typeof document === 'undefined') return;
  for (const id of ['title-screen', 'pause-menu', 'game-over-screen', 'mission-dialog']) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
}

function showTitle() {
  if (typeof document === 'undefined') return;
  hideOverlays();
  const el = document.getElementById('title-screen');
  if (el) el.hidden = false;
}

function setTimeOfDay(G, hour) {
  if (!G.time || typeof G.time !== 'object') G.time = {};
  G.time.hour = hour;
  G.time.hours = hour; // render + traffic read .hours
  G.time.night = hour < 6 || hour >= 19;
  if (typeof G.time.minute !== 'number') G.time.minute = 0;
}

function putPlayerOnFoot(G, x, y) {
  const p = G.player || (G.player = {});
  p.x = x;
  p.y = y;
  // On foot for the pose: drop any car so the pose is unambiguous.
  if (p.car) {
    try { p.car.driver = null; p.car.occupied = false; } catch (e) { /* ignore */ }
    p.car = null;
  }
  p.inCar = false;
  p.onFoot = true;
  p.driving = false;
  if (G.camera) { G.camera.x = x; G.camera.y = y; }
}

function startMissionById(G, missionId) {
  const m = G.missions;
  if (!m || typeof m.startMission !== 'function') return false;
  const idx = MISSION_INDEX[missionId];
  if (idx === undefined) return false;
  try {
    return !!m.startMission(G, idx);
  } catch (e) { return false; }
}

function activeMissionId(G) {
  const m = G.missions;
  if (!m) return null;
  const active = m.active || m.current || null;
  if (!active) return null;
  return String(active.id || '').toLowerCase() || null;
}

function wantedLevel(G) {
  if (typeof G.wanted === 'number' && Number.isFinite(G.wanted)) return G.wanted;
  const heat = num(G.heat, 0);
  let w = 0;
  for (let i = 0; i < WANTED_STEPS.length; i += 1) {
    if (heat >= WANTED_STEPS[i]) w = i;
  }
  return w;
}

function dialogVisible(G) {
  const m = G.missions;
  if (m && m.dialogOpen) return true;
  if (typeof document === 'undefined') return false;
  try {
    const el = document.getElementById('mission-dialog');
    return !!(el && !el.hidden && el.offsetParent !== null);
  } catch (e) { return false; }
}

function raiseHeat(G, wanted) {
  const want = HEAT_FOR_WANTED[wanted] || 58;
  if (typeof G.heat === 'number') {
    if (G.heat < want) G.heat = want;
  } else {
    G.heat = want;
  }
}

// Stage one pose from its POSE_DEFS row, with URL options overriding
// the row (mission / wanted / time / autopilot). Returns true when the
// pose was staged.
function stagePose(G, name, opts) {
  const s = G.shots;
  const o = opts || {};
  const pose = normalizePose(name);
  if (!pose) return false;
  const def = POSE_DEFS[pose];
  s.pose = pose;
  s.staged = false;
  s.ready = false;
  try {
    if (typeof window !== 'undefined') window.__shotReady = false;
  } catch (e) { /* ignore */ }

  if (pose === 'start') {
    // Title overlay over the living city: nothing to drive.
    G.state = 'title';
    showTitle();
    s.staged = true;
    return true;
  }

  // All other poses play the live game.
  hideOverlays();
  G.state = 'playing';
  if (typeof G.paused !== 'undefined') G.paused = false;

  const nightPose = pose === 'night' || o.time === 'night';
  const missionId = o.mission || def.mission;
  const wanted = o.wanted || (nightPose ? 4 : def.wanted);
  setTimeOfDay(G, nightPose ? 22 : (o.time === 'day' ? 12 : def.hour));
  if (def.spot) putPlayerOnFoot(G, def.spot.x, def.spot.y);
  if (missionId) startMissionById(G, missionId);
  // The mission script sets its own cover heat (m7: 58); raise it for
  // the wanted-4 night pose.
  if (wanted > 0) raiseHeat(G, wanted);
  s.targetMission = missionId;
  s.targetWanted = wanted;
  if (o.autopilot !== false && def.drive) G.autopilotEnabled = true;
  if (!def.drive) G.autopilotEnabled = false;

  if (pose === 'mission') {
    // Offer m8 for real (needs the index setter on G.missions) so the
    // dialog the screenshot shows is the game's own offer, not a mock.
    const m = G.missions;
    try {
      if (m && typeof m.offerNext === 'function') {
        try { m.index = MISSION_INDEX.m8; } catch (e) { /* no setter — dialog stays down */ }
        m.offerNext(G);
      }
    } catch (e) { /* dialog is best-effort; the shootout still stages */ }
  }
  s.staged = true;
  return true;
}

function poseReady(G) {
  const s = G.shots;
  if (!s || !s.pose || s.ready) return false;
  if (s.pose === 'start') return G.state === 'title';
  if (s.pose === 'cover' || s.pose === 'night') {
    return activeMissionId(G) === (s.targetMission || '') && wantedLevel(G) >= (s.targetWanted || 3);
  }
  if (s.pose === 'mission') {
    return activeMissionId(G) === 'm8' && dialogVisible(G);
  }
  return false;
}

function markReady(G) {
  const s = G.shots;
  if (!s || s.ready) return;
  s.ready = true;
  try {
    if (typeof window !== 'undefined') window.__shotReady = true;
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- lifecycle

export function init(G) {
  if (!G.shots) {
    G.shots = {
      pose: null,
      staged: false,
      ready: false,
      targetMission: null,
      targetWanted: 0,
      stagePose: null,
    };
  }
  const s = G.shots;
  // The pose hook the screenshot tool calls (window.__stagePose).
  const hook = (name) => {
    const opts = readParams();
    return stagePose(G, name, opts);
  };
  s.stagePose = hook;
  try {
    if (typeof window !== 'undefined') {
      window.__stagePose = hook;
      if (typeof window.__shotReady === 'undefined') window.__shotReady = false;
      // Also reachable as G.stagePose for tools that look there.
      if (!G.stagePose) G.stagePose = hook;
    }
  } catch (e) { /* Node smoke test — no window */ }
  // URL pose (page load): stage immediately so the shot is ready even
  // though the game boots at the title screen (update() never runs there).
  if (!s.pose) {
    const params = readParams();
    if (params.pose) stagePose(G, params.pose, params);
  }
  return s;
}

export function update(G, dt) {
  const s = G.shots || init(G);
  // A pose requested after boot (via the hook) stages on the next frame.
  if (s.pose && !s.staged) {
    const params = readParams();
    stagePose(G, s.pose, params);
  }
  if (poseReady(G)) markReady(G);
}

export function draw(G, ctx) {
  // Poses are staged game state, not drawn art. The ready check lives
  // here because draw runs every frame in every game state — including
  // 'dialog', where update() never runs but the mission pose must still
  // report ready once the fixer dialog is visible.
  try {
    if (poseReady(G)) markReady(G);
  } catch (e) { /* readiness is never fatal */ }
}

export default { init, update, draw, stagePose: null };
