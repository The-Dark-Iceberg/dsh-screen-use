/**
 * dsh-screen-use — runtime shared by every tool call and by the floating panel.
 *
 * What lives here
 * ---------------
 * 1. The Windows layer: screen capture, mouse/keyboard synthesis, window facts.
 * 2. The safety layer: two user-owned gates (screen reading, desktop control),
 *    the Escape kill switch, and takeover detection so a real user always wins
 *    the pointer back.
 * 3. The token layer: the policy that decides whether a capture is worth
 *    attaching as an image at all.
 *
 * The native helpers in `src/` are adapted from the MIT-licensed
 * `dsh-computer-use` project (see NOTICE); the coordination above them is this
 * plugin's own.
 *
 * @module dsh-screen-use/screen
 */

'use strict';

const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdirSync, statSync, writeFileSync } = require('node:fs');

/** Load the native helpers once, from either the source layout or a flat one. */
let cachedHelpers = null;
function helpers() {
  if (cachedHelpers !== null) return cachedHelpers;
  const here = __dirname;
  const candidates = {
    win32: [join(here, '..', 'src', 'win32.cjs')],
    capture: [join(here, '..', 'src', 'capture.cjs')],
    png: [join(here, '..', 'src', 'png.cjs')],
  };
  const first = (list, label) => {
    const errors = [];
    for (const candidate of list) {
      try {
        return require(candidate);
      } catch (error) {
        errors.push(`${candidate}: ${error.code ?? error.message}`);
      }
    }
    throw new Error(`dsh-screen-use: cannot load the ${label} helper. Tried: ${errors.join(' | ')}`);
  };
  cachedHelpers = {
    win32: first(candidates.win32, 'Win32'),
    capture: first(candidates.capture, 'capture'),
    png: first(candidates.png, 'PNG'),
  };
  return cachedHelpers;
}

/** A control action refused because the user switched the gate off. */
class ScreenGateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScreenGateError';
    this.code = 'screen-use/disabled';
  }
}

/** An action aborted by the user (Escape, or the user taking the pointer). */
class ScreenAbortError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'ScreenAbortError';
    this.code = 'screen-use/stopped';
    this.reason = reason;
  }
}

/** Clamp a numeric argument, falling back when it is absent or not finite. */
function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Block the calling thread briefly, for sub-50ms gaps inside one gesture. */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** @returns a promise resolved after `ms` milliseconds. */
function wait(ms) {
  const delay = Math.max(0, Math.min(120000, Math.round(ms)));
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
}

/** Write a capture, verifying it really landed. */
function writeFileSyncSafe(file, data) {
  try {
    writeFileSync(file, data);
    const stats = statSync(file);
    if (stats.size !== data.length) {
      throw new Error(`wrote ${stats.size} bytes but expected ${data.length}`);
    }
  } catch (error) {
    throw new Error(`dsh-screen-use: cannot write the capture to ${file} (${error.message})`);
  }
}

/**
 * A cheap FNV-1a fingerprint over a sampled subset of an RGBA buffer.
 *
 * Sampling, not an exhaustive hash: it only ever answers "is this the same
 * picture as last time", and a 64-byte stride is far more than enough to notice
 * a dialog appearing or a line of text landing.
 *
 * @param pixels - RGBA bytes.
 * @returns an unsigned 32-bit fingerprint.
 */
function pixelSignature(pixels) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i += 64) {
    hash = Math.imul(hash ^ pixels[i], 0x01000193) >>> 0;
    hash = Math.imul(hash ^ (pixels[i + 1] ?? 0), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ (pixels[i + 2] ?? 0), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The bounding box of pixels that differ between two same-sized frames.
 *
 * @param a - previous RGBA frame.
 * @param b - current RGBA frame.
 * @param width - frame width.
 * @param height - frame height.
 * @param tolerance - summed RGB distance treated as noise.
 * @returns `{x, y, width, height, ratio}` in frame pixels, or null when identical.
 */
function changeBox(a, b, width, height, tolerance = 24) {
  if (a === undefined || b === undefined || a.length !== b.length) return null;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let changed = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const offset = row + x * 4;
      const delta =
        Math.abs(a[offset] - b[offset]) +
        Math.abs(a[offset + 1] - b[offset + 1]) +
        Math.abs(a[offset + 2] - b[offset + 2]);
      if (delta <= tolerance) continue;
      changed += 1;
      if (x < left) left = x;
      if (y < top) top = y;
      if (x > right) right = x;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
    ratio: changed / (width * height),
  };
}

/** Fraction of sampled pixels that differ beyond `tolerance`. */
function frameDifference(a, b, tolerance) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 1;
  const pa = a.pixels;
  const pb = b.pixels;
  let changed = 0;
  let total = 0;
  for (let i = 0; i < pa.length; i += 4) {
    const delta =
      Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
    total += 1;
    if (delta > tolerance) changed += 1;
  }
  return total === 0 ? 0 : changed / total;
}

/**
 * Owns screen access for one host plugin instance.
 *
 * The two gates default to OFF and are deliberately not persisted: after a
 * restart the plugin starts unable to read the screen or touch the mouse until a
 * human flips the switches again. That is the point of the switch — a forgotten
 * ON must not quietly spend tokens on every later session.
 */
class ScreenUseRuntime {
  /**
   * @param options - `{ config, logger }` from the host plugin.
   */
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.outDir = config.outputDirectory && config.outputDirectory.length > 0
      ? config.outputDirectory
      : join(tmpdir(), 'dsh-screen-use');
    mkdirSync(this.outDir, { recursive: true });

    /** @type {{read: boolean, control: boolean, emergencyStop: boolean, stopReason: string | null, stopAt: number | null}} */
    this.gates = { read: false, control: false, emergencyStop: false, stopReason: null, stopAt: null };

    this.captureSeq = 0;
    this.lastCaptures = new Map(); // region key -> { signature, at, seq, pixels, width, height, region }
    this.recentCaptures = []; // timestamps for the per-minute rate limit
    this.stats = { images: 0, unchanged: 0, rateLimited: 0, throttled: 0 };
    this.actionRunning = false;
    this.heldButtons = new Set();
    this.escTimer = null;
  }

  // -------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------

  /** @returns the panel-visible state. */
  state() {
    const api = helpers().win32.win32();
    let screen = null;
    let cursor = null;
    try {
      const d = api.desktop();
      screen = { width: d.width, height: d.height, originX: d.x, originY: d.y, monitors: d.monitors };
    } catch {
      screen = null;
    }
    try {
      cursor = api.cursorPosition();
    } catch {
      cursor = null;
    }
    return {
      read: this.gates.read,
      control: this.gates.control,
      emergencyStop: this.gates.emergencyStop,
      stopReason: this.gates.stopReason,
      stopAt: this.gates.stopAt,
      screen,
      cursor,
      stats: { ...this.stats, captures: this.captureSeq },
      outputDirectory: this.outDir,
    };
  }

  /** @param value - read gate. */
  setRead(value) {
    this.gates.read = Boolean(value);
    if (this.logger !== undefined) this.logger.info(`dsh-screen-use: screen reading ${this.gates.read ? 'ON' : 'OFF'}`);
    return this.state();
  }

  /**
   * Arm or disarm desktop control.
   *
   * Arming is refused while an emergency stop stands: only an explicit
   * `resume()` clears it, and only the floating panel calls that. A model can
   * therefore never undo a stop the user pressed Escape for.
   *
   * @param value - desired state.
   * @param options - `{ resume }` to clear an emergency stop first.
   * @returns the new state.
   */
  setControl(value, options = {}) {
    if (value === true && this.gates.emergencyStop && options.resume !== true) {
      throw new ScreenGateError(
        'Desktop control is halted by an emergency stop. The user must clear it in the dsh-screen-use panel (or ' +
          'refresh and press "解除急停") before any mouse or keyboard action can run again.',
      );
    }
    if (value === true && options.resume === true) {
      this.gates.emergencyStop = false;
      this.gates.stopReason = null;
      this.gates.stopAt = null;
    }
    this.gates.control = Boolean(value);
    if (this.gates.control) {
      this.startEscWatch();
    } else {
      this.stopEscWatch();
    }
    if (this.logger !== undefined) this.logger.info(`dsh-screen-use: desktop control ${this.gates.control ? 'ARMED' : 'off'}`);
    return this.state();
  }

  /**
   * Halt everything.
   * @param reason - `esc` or `panel`; kept as a string so a future stop source can name itself.
   * @returns the new state.
   */
  stop(reason) {
    const wasArmed = this.gates.control;
    this.gates.control = false;
    this.gates.emergencyStop = true;
    this.gates.stopReason = reason;
    this.gates.stopAt = Date.now();
    this.stopEscWatch();
    // A stop can land between a press and its release (the drag path checks
    // Escape mid-gesture), which would otherwise leave a button logically down.
    this.releaseButtons();
    if (this.logger !== undefined) {
      this.logger.warn(
        `dsh-screen-use: STOP (${reason})${wasArmed ? '' : ' [control was already off]'} — mouse and keyboard injection is now blocked until the user resumes.`,
      );
    }
    return this.state();
  }

  /** Release every mouse button this plugin is currently holding. */
  releaseButtons() {
    if (this.heldButtons.size === 0) return;
    try {
      const win = helpers().win32;
      for (const button of this.heldButtons) win.mouseUp(button);
    } catch {
      // Best effort: a failed release must not mask the stop itself.
    } finally {
      this.heldButtons.clear();
    }
  }

  /** Throw unless screen reading is enabled. */
  requireRead() {
    if (!this.gates.read) {
      throw new ScreenGateError(
        'Screen reading is OFF in the dsh-screen-use panel. Ask the user to switch 「读取屏幕」on there, then retry. ' +
          'Do not guess at what is on screen in the meantime.',
      );
    }
  }

  /** Throw unless desktop control is armed and no emergency stop stands. */
  requireControl() {
    if (this.gates.emergencyStop) {
      throw new ScreenGateError(
        `Desktop control is stopped (${this.gates.stopReason ?? 'manual'}). The user must clear it in the ` +
          'dsh-screen-use panel; ask them to do that, then retry. Never describe an action as done in the meantime.',
      );
    }
    if (!this.gates.control) {
      throw new ScreenGateError(
        'Desktop control is OFF in the dsh-screen-use panel. Ask the user to switch 「允许操作」on there, then retry.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Escape watch / takeover
  // -------------------------------------------------------------------------

  /** Poll the physical Escape key while control is armed. */
  startEscWatch() {
    if (this.escTimer !== null) return;
    // Prime the pressed bit so a keypress from before arming is not read as a
    // fresh Escape once the loop starts.
    try {
      helpers().win32.escapeDown();
    } catch {
      // The first tick reports a binding failure if there is one.
    }
    const timer = setInterval(() => {
      try {
        if (helpers().win32.escapeDown()) this.stop('esc');
      } catch {
        // A probe failure must not disarm the watcher; the next tick retries.
      }
    }, 40);
    timer.unref?.();
    this.escTimer = timer;
  }

  /** Stop polling Escape. */
  stopEscWatch() {
    if (this.escTimer === null) return;
    clearInterval(this.escTimer);
    this.escTimer = null;
  }

  /**
   * The pre-action guard: Escape is the one and only emergency brake.
   *
   * It deliberately does NOT look at the pointer or the mouse buttons. The user
   * and the automation are allowed to use the mouse at the same time — a hand
   * tremor, a scroll, or the user taking over the pointer must not tear down an
   * armed session. The explicit, unambiguous stop is Escape (or the panel's stop
   * button), which reaches `stop()` directly instead of racing a cursor check.
   */
  guardBeforeAction() {
    this.requireControl();
    if (helpers().win32.escapeDown()) {
      this.stop('esc');
      throw new ScreenAbortError('The user pressed Escape. Control is stopped and must stay stopped until they resume.', 'esc');
    }
  }

  /**
   * The post-action guard: Escape, checked again because a gesture can span a
   * keypress. Pointer ownership is intentionally not part of it.
   */
  guardAfterAction() {
    if (helpers().win32.escapeDown()) {
      this.stop('esc');
      throw new ScreenAbortError('The user pressed Escape mid-action. Control is stopped.', 'esc');
    }
  }

  // -------------------------------------------------------------------------
  // Geometry helpers
  // -------------------------------------------------------------------------

  /** @returns the bound win32 API surface. */
  api() {
    return helpers().win32.win32();
  }

  /** Full virtual-desktop bounds. */
  desktop() {
    const d = this.api().desktop();
    return { x: d.x, y: d.y, width: d.width, height: d.height };
  }

  /** Keep a region inside the virtual desktop. */
  clampRegion(region) {
    const d = this.desktop();
    const left = Math.max(d.x, Math.round(region.x));
    const top = Math.max(d.y, Math.round(region.y));
    const right = Math.min(d.x + d.width, Math.round(region.x + region.width));
    const bottom = Math.min(d.y + d.height, Math.round(region.y + region.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /** Clamp a region to a real size and report it, or throw. */
  checkedRegion(region, label = 'region') {
    const area = this.clampRegion(region);
    if (!(area.width > 0) || !(area.height > 0)) {
      throw new Error(`the ${label} is empty after clamping to the desktop (${area.width}x${area.height})`);
    }
    return area;
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  /** @returns the directory captures are written to. */
  captureDirectory() {
    return this.outDir;
  }

  /**
   * Capture one image under the token policy.
   *
   * Returns `{ png, meta }`; `png` is null whenever the policy decided the image
   * is not worth attaching (unchanged, rate-limited), and `meta.skip` explains
   * which rule did it. Callers must read `meta` rather than assume an image.
   *
   * @param args - `region`, `window`, `maxDimension`, `grid`, `force`, `changeOnly`.
   * @param options - `{ gated }`: false for the panel preview, which has its own gate.
   * @returns `{ png, meta }`.
   */
  capture(args = {}, options = {}) {
    if (options.gated !== false) this.requireRead();
    const preview = options.preview === true;
    const win = helpers().win32;

    let area;
    let windowInfo = null;
    let source;
    let label;

    if (typeof args.window === 'string' && args.window.length > 0) {
      const target = win.findWindow(args.window);
      if (target === null) throw new Error(`no visible window matches ${JSON.stringify(args.window)}`);
      area = target.bounds;
      label = `window ${JSON.stringify(target.title)}`;
      windowInfo = { handle: target.handle, title: target.title, minimized: target.minimized };
    } else if (args.region !== undefined && args.region !== null) {
      area = this.checkedRegion(args.region);
      label = 'region';
    } else {
      area = this.desktop();
      label = 'full screen';
    }

    const cap = this.captureCap(args, area);
    const longest = Math.max(area.width, area.height);
    const scale = Math.min(1, cap / longest);
    const scaleX = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const scaleY = scaleX;

    // Cooldown: a model that fires captures in a tight loop gains nothing from
    // the second one, and the scheduler does not need the load. Waiting is
    // better than failing, because a failure costs another turn.
    const lastAt = this.recentCaptures[this.recentCaptures.length - 1] ?? 0;
    const elapsed = Date.now() - lastAt;
    if (!preview && elapsed < this.config.minCaptureIntervalMs) {
      const pause = this.config.minCaptureIntervalMs - elapsed;
      if (pause > 0 && pause < 2000) {
        sleepSync(pause);
        this.stats.throttled += 1;
      }
    }

    if (windowInfo !== null) {
      // `captureWindow` lives on the capture helper, not on the win32 surface.
      source = helpers().capture.captureWindow(windowInfo.handle, { scaleX, scaleY });
      area = source.region;
    } else {
      source = helpers().capture.captureRegion(area, { scaleX, scaleY });
    }

    let pixels = source.pixels;
    if (args.grid === true) {
      pixels = helpers().png.drawRulers(source.width, source.height, pixels, {
        originX: area.x,
        originY: area.y,
        scaleX: source.width / area.width,
        scaleY: source.height / area.height,
      });
    }
    const signature = pixelSignature(pixels);

    const key = `${windowInfo !== null ? `w${windowInfo.handle}` : 'r'}:${area.x},${area.y},${area.width}x${area.height}:${source.width}x${source.height}`;
    // A preview is a local viewer frame: it must never become the baseline the
    // model's next capture is compared with, or the model would be told
    // "unchanged" against an image it was never sent.
    const previous = preview ? undefined : this.lastCaptures.get(key);
    const changed = previous === undefined ? undefined : previous.signature !== signature;
    const at = Date.now();

    if (!preview) {
      this.lastCaptures.set(key, {
        signature,
        at,
        seq: this.captureSeq,
        pixels,
        width: source.width,
        height: source.height,
        area,
      });
      if (this.lastCaptures.size > 4) {
        const oldest = [...this.lastCaptures.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest !== undefined && oldest[0] !== key) this.lastCaptures.delete(oldest[0]);
      }

      this.recentCaptures.push(at);
      while (this.recentCaptures.length > 0 && at - this.recentCaptures[0] > 60000) this.recentCaptures.shift();
    }

    const meta = {
      label,
      region: area,
      width: source.width,
      height: source.height,
      scale: Number((source.width / Math.max(1, area.width)).toFixed(4)),
      native: source.width === area.width && source.height === area.height,
      signature,
      changed,
      at,
      window: windowInfo ?? undefined,
      skip: undefined,
    };

    // Rule 1: one image per changed screen. An identical frame is the single
    // biggest waste in a computer-use loop, so it is not attached again.
    if (!preview && this.recentCaptures.length > this.config.maxCapturesPerMinute) {
      meta.skip = 'rate-limited';
      this.stats.rateLimited += 1;
      return { png: null, meta };
    }
    if (!preview && changed === false && args.force !== true) {
      meta.skip = 'unchanged';
      this.stats.unchanged += 1;
      return { png: null, meta };
    }

    // Rule 2: change-only mode crops to the part that actually moved, then
    // recaptures that part at native resolution. A 200x80 toast becomes a
    // 200x80 image instead of a whole 1920x1080 frame.
    if (args.changeOnly === true && previous !== undefined && previous.pixels !== undefined) {
      const box = changeBox(previous.pixels, pixels, source.width, source.height);
      if (box !== null && box.ratio > 0 && box.ratio < 0.6) {
        const scaleXReal = area.width / source.width;
        const scaleYReal = area.height / source.height;
        const pad = 24;
        const crop = this.checkedRegion(
          {
            x: area.x + box.x * scaleXReal - pad,
            y: area.y + box.y * scaleYReal - pad,
            width: (box.width + pad * 2) * scaleXReal,
            height: (box.height + pad * 2) * scaleYReal,
          },
          'changed area',
        );
        const cropCap = this.captureCap({ ...args, region: crop }, crop);
        const cropScale = Math.min(1, cropCap / Math.max(crop.width, crop.height));
        const shot = helpers().capture.captureRegion(crop, { scaleX: cropScale, scaleY: cropScale });
        let cropPixels = shot.pixels;
        if (args.grid === true) {
          cropPixels = helpers().png.drawRulers(shot.width, shot.height, cropPixels, {
            originX: crop.x,
            originY: crop.y,
            scaleX: shot.width / crop.width,
            scaleY: shot.height / crop.height,
          });
        }
        meta.region = crop;
        meta.width = shot.width;
        meta.height = shot.height;
        meta.scale = Number((shot.width / Math.max(1, crop.width)).toFixed(4));
        meta.native = shot.width === crop.width && shot.height === crop.height;
        meta.changeOnly = { ratio: Number(box.ratio.toFixed(4)), source: area };
        pixels = cropPixels;
      }
    }

    const png = helpers().png.encodePng(meta.width, meta.height, pixels, { level: this.config.pngLevel });
    const pngBuffer = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
    this.captureSeq += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(this.outDir, `screen-${stamp}-${this.captureSeq}.png`);
    writeFileSyncSafe(file, pngBuffer);
    meta.file = file;
    meta.bytes = pngBuffer.length;
    if (!preview) this.stats.images += 1;
    return { png: pngBuffer, meta };
  }

  /**
   * The longest side this capture may have.
   *
   * Token policy: a whole desktop is an overview, not a document, so it is
   * capped well below native; an explicit region is where the model asked for
   * detail, so it gets native resolution up to a larger cap.
   *
   * @param args - the capture arguments.
   * @param area - the source area.
   * @returns the pixel cap.
   */
  captureCap(args, area) {
    if (typeof args.maxDimension === 'number' && Number.isFinite(args.maxDimension)) {
      return clampNumber(args.maxDimension, 320, 4096, 1024);
    }
    if (args.region !== undefined || typeof args.window === 'string') {
      return this.config.nativeMaxDimension;
    }
    return this.config.overviewMaxDimension;
  }

  /**
   * A small raw frame for change watching: no PNG, no attachment, no disk write.
   * @param region - screen area, or the whole desktop.
   * @param maxDimension - longest side of the probe.
   * @returns frame.
   */
  probe(region, maxDimension = 420) {
    const area = this.checkedRegion(region ?? this.desktop(), 'probe region');
    const longest = Math.max(area.width, area.height);
    const factor = longest > maxDimension ? maxDimension / longest : 1;
    const shot = helpers().capture.captureRegion(area, { scaleX: factor, scaleY: factor });
    return { width: shot.width, height: shot.height, pixels: shot.pixels, region: area };
  }

  // -------------------------------------------------------------------------
  // Input actions
  // -------------------------------------------------------------------------

  /** Resolve and validate a target point. */
  targetPoint(args) {
    const x = args.x;
    const y = args.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('this action needs numeric `x` and `y` screen coordinates');
    }
    const d = this.desktop();
    if (x < d.x || y < d.y || x >= d.x + d.width || y >= d.y + d.height) {
      throw new Error(
        `(${x}, ${y}) lies outside the desktop (${d.x}..${d.x + d.width - 1}, ${d.y}..${d.y + d.height - 1}). ` +
          'Capture the screen or a region and read the coordinates off the image.',
      );
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  /**
   * Move the pointer through a short intermediate path.
   *
   * Real cursors do not teleport in one event; a couple of intermediate
   * `SendInput` moves make drag-and-drop targets that track motion behave the
   * same as they would for a human, and give the takeover check several chances
   * to notice the user grabbing the mouse.
   *
   * @param from - start point.
   * @param to - end point.
   * @param steps - number of intermediate moves.
   */
  glidingMove(from, to, steps = 12) {
    const win = helpers().win32;
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      const x = Math.round(from.x + (to.x - from.x) * t);
      const y = Math.round(from.y + (to.y - from.y) * t);
      win.moveCursor(x, y, { absolute: false });
      if (index < steps) {
        sleepSync(12);
        if (helpers().win32.escapeDown()) {
          this.stop('esc');
          throw new ScreenAbortError('The user pressed Escape during the drag. Control is stopped.', 'esc');
        }
      }
    }
  }

  /**
   * Click at a point.
   * @param point - target.
   * @param button - left|right|middle.
   * @param times - click count.
   * @param ensureForeground - raise the window under the point first.
   * @returns what happened.
   */
  clickAt(point, button, times, ensureForeground) {
    const win = helpers().win32;
    this.guardBeforeAction();
    let raised = null;
    if (ensureForeground !== false) {
      const target = win.windowFromPoint(point.x, point.y);
      if (target !== null) {
        const previous = win.foregroundHandle();
        if (previous !== target.handle) {
          win.activateWindow(target.handle);
          raised = { handle: target.handle, title: target.title, was: previous };
          sleepSync(60);
        }
      }
    }
    win.moveCursor(point.x, point.y, { absolute: false });
    sleepSync(25);
    for (let index = 0; index < times; index += 1) {
      win.mouseDown(button);
      this.heldButtons.add(button);
      sleepSync(times > 1 ? 30 : 40);
      win.mouseUp(button);
      this.heldButtons.delete(button);
      if (index + 1 < times) sleepSync(60);
    }
    sleepSync(40);
    this.guardAfterAction();
    return { raised };
  }

  /**
   * Drag from one point to another while the user keeps the right to abort it.
   * @param from - start.
   * @param to - end.
   * @param button - mouse button.
   * @returns what happened.
   */
  dragFromTo(from, to, button) {
    const win = helpers().win32;
    this.guardBeforeAction();
    win.moveCursor(from.x, from.y, { absolute: false });
    sleepSync(50);
    win.mouseDown(button);
    this.heldButtons.add(button);
    try {
      this.glidingMove(from, to, 14);
      sleepSync(90);
    } finally {
      win.mouseUp(button);
      this.heldButtons.delete(button);
    }
    sleepSync(50);
    this.guardAfterAction();
  }

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  /** Release the watcher and any held button. */
  dispose() {
    this.stopEscWatch();
    this.releaseButtons();
  }
}

module.exports = {
  ScreenUseRuntime,
  ScreenGateError,
  ScreenAbortError,
  helpers,
  wait,
  sleepSync,
  clampNumber,
  frameDifference,
  pixelSignature,
};
