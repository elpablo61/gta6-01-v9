// Crescent Bay — keyboard + mouse input state. One shared object is
// created by init() and read by player, vehicles, combat, the garage and
// the autopilot. Movement keys, action keys and the mouse aim live here;
// nothing else in the game touches window key events directly.

// Keys the game cares about, normalised to KeyboardEvent.code values.
const MOVE_KEYS = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

export function createInput() {
  return {
    // Held movement directions.
    up: false, down: false, left: false, right: false,
    // Held modifiers / actions.
    sprint: false,      // Shift
    interact: false,    // E (held)
    radio: false,       // R (held)
    switchWeapon: false,// Q (held)
    // Mouse aim, in canvas pixels (updated by mousemove).
    mouseX: 0, mouseY: 0,
    mouseDown: false,
    // Aim angle in world space, filled in by main.js each frame once the
    // camera is known (input itself only stores the screen position).
    aimX: 0, aimY: 0, aimAngle: 0,
    // Edge-triggered presses: set on keydown, consumed once by whoever
    // reads them, cleared at the end of each frame by endFrame().
    _pressed: new Set(),
    pressed(code) { return this._pressed.has(code); },
    consume(code) { this._pressed.delete(code); },
    endFrame() { this._pressed.clear(); },
    // Normalised movement vector (-1..1 on each axis).
    moveVector() {
      const x = (this.right ? 1 : 0) - (this.left ? 1 : 0);
      const y = (this.down ? 1 : 0) - (this.up ? 1 : 0);
      if (x === 0 && y === 0) return { x: 0, y: 0 };
      const len = Math.hypot(x, y);
      return { x: x / len, y: y / len };
    },
  };
}

// Attach window listeners that feed the shared input object. Call once
// from main.js. Returns a detach function for tests / teardown.
export function initInput(input, canvas) {
  function onKeyDown(e) {
    if (e.repeat) return;
    const dir = MOVE_KEYS[e.code];
    if (dir) { input[dir] = true; e.preventDefault(); }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.sprint = true;
    if (e.code === 'KeyE') input.interact = true;
    if (e.code === 'KeyR') input.radio = true;
    if (e.code === 'KeyQ') input.switchWeapon = true;
    // Edge presses: E / R / Q / digits / Escape / P / Enter / Space / M.
    input._pressed.add(e.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
  }
  function onKeyUp(e) {
    const dir = MOVE_KEYS[e.code];
    if (dir) input[dir] = false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.sprint = false;
    if (e.code === 'KeyE') input.interact = false;
    if (e.code === 'KeyR') input.radio = false;
    if (e.code === 'KeyQ') input.switchWeapon = false;
  }
  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    input.mouseX = e.clientX - rect.left;
    input.mouseY = e.clientY - rect.top;
  }
  function onMouseDown(e) {
    if (e.button === 0) input.mouseDown = true;
    onMouseMove(e);
  }
  function onMouseUp(e) {
    if (e.button === 0) input.mouseDown = false;
  }
  function onBlur() {
    // Losing focus must never leave a key stuck down.
    input.up = input.down = input.left = input.right = false;
    input.sprint = input.interact = input.radio = input.switchWeapon = false;
    input.mouseDown = false;
    input._pressed.clear();
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', onBlur);
  return function detach() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('blur', onBlur);
  };
}

// Helpers for the rest of the game: weapon selection keys 1/2/3.
export function weaponKeyPressed(input) {
  if (input.pressed('Digit1')) return 0;
  if (input.pressed('Digit2')) return 1;
  if (input.pressed('Digit3')) return 2;
  return -1;
}

export function pausePressed(input) {
  return input.pressed('Escape') || input.pressed('KeyP');
}

export function acceptPressed(input) {
  return input.pressed('KeyE') || input.pressed('Enter') || input.pressed('Space');
}

export default createInput;
