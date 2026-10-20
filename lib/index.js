/**
 * dsh-screen-use — host half.
 *
 * Gives an agent a real view of the desktop and a real mouse, while keeping both
 * behind switches the user owns:
 *
 *   GET  /dsh-screen-use/state     gate state, stop reason, counters, screen facts
 *   POST /dsh-screen-use/state     the panel's switches (read / control / stop / resume)
 *   GET  /dsh-screen-use/preview   a small fresh frame for the panel's live preview
 *
 * The runtime in `./screen.cjs` owns capture, input synthesis, the Escape kill
 * switch, takeover detection, and the token policy. This file only turns that
 * into model-facing tools, a prompt policy, and the panel's HTTP face.
 *
 * CommonJS is required: `koffi`, `@deepseek-ai/dsh-tools` and
 * `@deepseek-ai/schemastery` ship inside the installation's asar archive, and
 * only CommonJS `require` goes through Electron's asar-aware resolver.
 *
 * @module dsh-screen-use
 */

'use strict';

const { requireFromInstall } = require('./loader.cjs');
const {
  ScreenUseRuntime,
  ScreenGateError,
  ScreenAbortError,
  helpers,
  wait,
  clampNumber,
  frameDifference,
} = require('./screen.cjs');

const { defineTool } = requireFromInstall('@deepseek-ai/dsh-tools', 'tool registration');
const z = requireFromInstall('@deepseek-ai/schemastery', 'plugin configuration schema');

/** Cordis plugin name; matches the bundle row id in cordis.patch.yml. */
const name = 'dsh-screen-use';

/** The tool registry is the only hard dependency. */
const inject = ['tools'];

/** Route namespace owned by this plugin. */
const ROUTE_PREFIX = '/dsh-screen-use';

/** Largest accepted request body for the state route. */
const BODY_LIMIT_BYTES = 16 * 1024;

/** Plugin configuration. */
const Config = z.object({
  /** Master switch; when false no tool is registered. */
  enabled: z.boolean().default(true),
  /**
   * Longest side of a whole-desktop capture. This is the main token lever: the
   * model sees an overview, not a 1920px document, and can ask for a region at
   * native resolution when it needs detail.
   */
  overviewMaxDimension: z.number().default(1024),
  /** Longest side of an explicit region/window capture (where detail matters). */
  nativeMaxDimension: z.number().default(1400),
  /** PNG deflate effort, 1-9. Higher is smaller and slower. */
  pngLevel: z.number().default(6),
  /** Minimum gap between two captures; a tighter request waits instead of failing. */
  minCaptureIntervalMs: z.number().default(800),
  /** Captures allowed per rolling minute before images are withheld (text still returned). */
  maxCapturesPerMinute: z.number().default(24),
  /** Directory for captured PNGs. Empty uses the OS temp directory. */
  outputDirectory: z.string().default(''),
});

// ---------------------------------------------------------------------------
// Model-facing text
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = [
  'Read this computer\'s real desktop and synthesize real mouse/keyboard input.',
  'Two user-owned switches in the dsh-screen-use floating panel gate it, and both start OFF:',
  '「读取屏幕」for `windows`/`capture`, and 「允许操作」for every input action.',
  'A refusal names the switch to ask the user for; never claim an action ran while blocked.',
  'Safety: the user and you share one mouse and keyboard; a hand tremor, a scroll or the user taking',
  'the pointer does NOT stop you. The explicit stop is the user pressing Escape (or the panel\'s stop',
  'button), which disarms control immediately and blocks every later action until the user resumes.',
  'Never try to bypass a stop.',
  'Token policy: whole-screen captures are downscaled to an overview, an unchanged screen is returned',
  'as text WITHOUT a second image, and repeated captures are cooled down. Prefer `windows`/`info`',
  '(free text) before pixels, capture a `region` or `window` for detail, and use wait_change to',
  'avoid polling screenshots. With `native: true`, image pixel + region origin = screen coordinate.',
].join(' ');

const BATCH_DESCRIPTION = [
  'Run a short sequence of `screen` actions in one call (click, type, Enter), which costs one turn',
  'instead of many. Every step uses the same fields as `screen`. Stops at the first failure and',
  'reports the step log. Set `captureAtEnd: true` to attach ONE verification image of the result,',
  'or pass an explicit final `capture` step; do not capture between every step.',
].join(' ');

const SYSTEM_POLICY = [
  'Screen-use policy (the `screen` tool and its dsh-screen-use panel):',
  '',
  'Use exact interfaces first. A file, command, API or settings page that can be read or changed',
  'directly is cheaper and more reliable than pixels and clicks. Reach for the screen only when the',
  'task depends on something that exists only visually: a GUI with no CLI, a rendered layout, a',
  'dialog, a canvas, or "what is on my screen right now".',
  '',
  'Token discipline matters here because every image is paid for again on later requests. Take one',
  'capture per meaningful state change, never one per loop iteration. Ask for the smallest `region`',
  'or the `window` you actually need instead of the whole desktop. Read `windows`/`info` first: they',
  'cost no image. After acting, prefer `wait_change` or `wait_stable` (no image) and capture once',
  'when it settles. If a capture reports the screen is unchanged, do not capture again — act or wait.',
  '',
  'Work in small verified steps, and say what you are about to do before anything destructive or',
  'irreversible (deleting, overwriting, sending, purchasing, closing unsaved work). Never click a',
  'security or elevation prompt (UAC, antivirus, "allow access"): that choice belongs to the user.',
  '',
  'You and the user share the same pointer and keyboard: the user may move the mouse, scroll or type',
  'while you are working, and that is not a stop. The one stop that matters is Escape (or the panel\'s',
  'stop button). When a tool reports that control was stopped, stop operating and ask the user whether',
  'to resume — never try to route around the stop, and never describe a blocked action as done.',
].join('\n');

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Mount the host plugin.
 * @param ctx - the plugin's Cordis context.
 * @param config - validated plugin configuration.
 */
function apply(ctx, config) {
  if (config.enabled === false) {
    ctx.logger?.info?.('dsh-screen-use: disabled by config; no tools registered');
    return;
  }

  const runtime = new ScreenUseRuntime({ config, logger: ctx.logger });
  ctx.effect(() => () => runtime.dispose(), 'dsh-screen-use: runtime');

  /** Attach one captured PNG through the attachment service. */
  async function attach(png, meta) {
    const attachments = ctx.get('attachments');
    if (attachments === undefined || typeof attachments.saveImage !== 'function') {
      meta.attachmentError =
        'no attachment service is mounted, so this image cannot be delivered; read it with read_image';
      return [];
    }
    try {
      const ref = await attachments.saveImage({
        data: new Uint8Array(png),
        mediaType: 'image/png',
        name: `screen-${meta.region.x}-${meta.region.y}.png`,
      });
      return [{
        attachment: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          name: ref.name ?? `screen-${meta.region.x}-${meta.region.y}.png`,
        },
        width: meta.width,
        height: meta.height,
        region: meta.region,
        scale: meta.scale,
        native: meta.native,
        file: meta.file,
        hint: meta.native
          ? `Full resolution: image pixel + region origin (${meta.region.x}, ${meta.region.y}) = screen coordinate.`
          : `Downscaled by ${meta.scale}: screen = region origin + image point / ${meta.scale}.`,
      }];
    } catch (error) {
      meta.attachmentError = error.message;
      return [];
    }
  }

  /** Describe a capture, including why an image is or is not attached. */
  function describeCapture(meta) {
    const parts = [
      `Captured ${meta.label}: ${meta.width}x${meta.height} image of a ${meta.region.width}x${meta.region.height} ` +
        `screen area at (${meta.region.x}, ${meta.region.y}).`,
    ];
    if (!meta.native) {
      parts.push(`Scaled by ${meta.scale}: screen = region origin + image point / ${meta.scale}.`);
    } else {
      parts.push('Image pixels are screen pixels: add the region origin to convert a point into a click coordinate.');
    }
    if (meta.skip === 'unchanged') {
      parts.push(
        'The screen is pixel-identical to the previous capture of that area, so NO image was attached — ' +
          'that is the token-saving rule, not an error. The previous image is still the current picture; do not ' +
          'capture again until something has changed (use wait_change). Pass force: true only if you genuinely ' +
          'need a fresh copy.',
      );
    } else if (meta.skip === 'rate-limited') {
      parts.push(
        'The per-minute capture budget was reached, so NO image is attached. Use wait_change, or a small `region`, ' +
          'and capture again after the next action.',
      );
    }
    if (meta.changeOnly !== undefined) {
      parts.push(
        `Only the changed area was captured (${(meta.changeOnly.ratio * 100).toFixed(1)}% of ` +
          `${meta.changeOnly.source.width}x${meta.changeOnly.source.height} changed).`,
      );
    }
    if (meta.grid === true) parts.push('A labelled coordinate ruler is drawn in screen pixels.');
    if (meta.window !== undefined) parts.push(`Source window ${JSON.stringify(meta.window.title)}.`);
    if (meta.attachmentError !== undefined && meta.skip === undefined) {
      parts.push(`NO IMAGE WAS ATTACHED (${meta.attachmentError}); the PNG is at ${meta.file}.`);
    }
    return parts.join(' ');
  }

  /** Screen facts returned alongside a capture. */
  function screenContext() {
    const api = runtime.api();
    const d = api.desktop();
    return {
      screen: { width: d.width, height: d.height, originX: d.x, originY: d.y, dpi: d.dpi },
      cursor: api.cursorPosition(),
    };
  }

  /** Render the window list as text (it must be rendered, not merely returned). */
  function formatWindows(windows, foreground) {
    if (windows.length === 0) {
      return 'No titled top-level windows are visible; capture the whole screen instead.';
    }
    const lines = windows.map((w) =>
      `${w.handle} | ${w.bounds.width}x${w.bounds.height} at ${w.bounds.x},${w.bounds.y} | pid ${w.pid} | ${w.title}`,
    );
    return (
      `${windows.length} window(s), largest first. Format: handle | size at x,y | pid | title.\n` +
      (foreground === null ? '' : `Foreground: ${foreground.handle} ${JSON.stringify(foreground.title)}.\n`) +
      lines.join('\n')
    );
  }

  /** The gate/stop refusal, as a normal tool result instead of a thrown error. */
  function blocked(error) {
    return {
      status: error instanceof ScreenAbortError ? 'stopped' : 'blocked',
      message: error.message,
      gate: runtime.state(),
    };
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Run one action.
   * @param action - action name.
   * @param args - action arguments.
   * @returns the tool value (images included for captures).
   */
  async function runAction(action, args) {
    switch (action) {
      case 'info': {
        const api = runtime.api();
        const d = api.desktop();
        const fg = helpers().win32.foregroundWindow();
        const gate = runtime.state();
        return {
          status: 'ok',
          message:
            `Desktop is ${d.width}x${d.height} physical pixels at (${d.x}, ${d.y}); ${d.monitors} monitor(s), ` +
            `DPI ${d.dpi}. Screenshots and input share this space, so no conversion is needed. ` +
            `Cursor is at (${api.cursorPosition().x}, ${api.cursorPosition().y}).` +
            (gate.read ? '' : ' Screen reading is OFF in the panel, so `windows` and `capture` will be refused until the user turns it on.'),
          screen: {
            width: d.width,
            height: d.height,
            originX: d.x,
            originY: d.y,
            monitors: d.monitors,
            dpi: d.dpi,
          },
          cursor: api.cursorPosition(),
          ...(fg === null ? {} : { foregroundWindow: fg }),
          gate,
        };
      }

      case 'windows': {
        runtime.requireRead();
        const { windows, filtered } = helpers().win32.inspectWindows({ includeMinimized: true });
        const sorted = [...windows].sort(
          (a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height,
        );
        const foreground = helpers().win32.foregroundWindow();
        return {
          status: 'ok',
          message:
            formatWindows(sorted, foreground) +
            (filtered.length > 0
              ? `\n(${filtered.length} helper window(s) without titles were skipped.)`
              : ''),
          windows: sorted,
          count: sorted.length,
          ...(foreground === null ? {} : { foregroundWindow: foreground }),
        };
      }

      case 'focus': {
        const selector = args.handle ?? args.title ?? args.window;
        if (selector === undefined) throw new Error('focus needs `title` or `handle`');
        const target =
          args.handle !== undefined
            ? helpers().win32.findWindow(String(args.handle))
            : helpers().win32.findWindow(String(args.title ?? args.window));
        if (target === null) throw new Error(`no visible window matches ${JSON.stringify(selector)}`);
        const outcome = helpers().win32.activateWindow(target.handle);
        let foreground = helpers().win32.foregroundHandle();
        const started = Date.now();
        while (foreground !== target.handle && Date.now() - started < 500) {
          await wait(30);
          foreground = helpers().win32.foregroundHandle();
        }
        return {
          status: foreground === target.handle ? 'ok' : 'warning',
          message:
            foreground === target.handle
              ? `Raised ${JSON.stringify(target.title)} (${target.handle}) to the foreground.`
              : `Asked to raise ${JSON.stringify(target.title)}, but the foreground is now ${foreground}.`,
          performed: { action: 'focus', handle: target.handle, requested: outcome.requested, foreground },
        };
      }

      case 'capture': {
        const { png, meta } = runtime.capture(args);
        meta.grid = args.grid === true;
        const images = png === null ? [] : await attach(png, meta);
        const screenshot = {
          label: meta.label,
          region: meta.region,
          width: meta.width,
          height: meta.height,
          scale: meta.scale,
          native: meta.native,
        };
        // Only lossless JSON values may appear: an `undefined` field would make
        // the dispatcher reject the whole tool result ("not lossless JSON").
        if (meta.changed !== undefined) screenshot.changed = meta.changed;
        if (meta.skip !== undefined) screenshot.skip = meta.skip;
        if (meta.file !== undefined) {
          screenshot.file = meta.file;
          screenshot.bytes = meta.bytes;
        }
        if (meta.changeOnly !== undefined) screenshot.changeOnly = meta.changeOnly;
        return {
          status: 'ok',
          message: describeCapture(meta),
          images,
          screenshot,
          ...screenContext(),
        };
      }

      case 'move': {
        const point = runtime.targetPoint(args);
        runtime.guardBeforeAction();
        helpers().win32.moveCursor(point.x, point.y, { absolute: false });
        await wait(40);
        runtime.guardAfterAction();
        return {
          status: 'ok',
          message: `Pointer moved to (${point.x}, ${point.y}).`,
          performed: { action: 'move', x: point.x, y: point.y },
          cursor: runtime.api().cursorPosition(),
        };
      }

      case 'click':
      case 'double_click':
      case 'right_click':
      case 'middle_click': {
        const point = runtime.targetPoint(args);
        const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left';
        const times = action === 'double_click' ? 2 : 1;
        const { raised } = runtime.clickAt(point, button, times, args.ensureForeground);
        return {
          status: 'ok',
          message:
            `${action === 'click' ? 'Clicked' : action === 'double_click' ? 'Double-clicked' : `Clicked ${button}`} ` +
            `at (${point.x}, ${point.y})` +
            (raised === null ? '.' : ` after raising ${JSON.stringify(raised.title)}.`) +
            ' Use wait_change or a small region capture to verify the result.',
          performed: { action, x: point.x, y: point.y, button, times },
          ...(raised === null ? {} : { raised }),
          cursor: runtime.api().cursorPosition(),
        };
      }

      case 'drag': {
        const from = runtime.targetPoint({ x: args.from?.x, y: args.from?.y });
        const to = runtime.targetPoint({ x: args.to?.x, y: args.to?.y });
        const button = args.button ?? 'left';
        runtime.dragFromTo(from, to, button);
        return {
          status: 'ok',
          message: `Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y}) with the ${button} button.`,
          performed: { action: 'drag', from, to, button },
          cursor: runtime.api().cursorPosition(),
        };
      }

      case 'scroll': {
        const point = runtime.targetPoint(args);
        const clicks = clampNumber(args.clicks, -20, 20, 3);
        runtime.guardBeforeAction();
        helpers().win32.moveCursor(point.x, point.y, { absolute: false });
        await wait(40);
        helpers().win32.scroll(clicks, args.horizontal === true);
        await wait(40);
        runtime.guardAfterAction();
        return {
          status: 'ok',
          message: `Scrolled ${clicks} notch(es) ${args.horizontal === true ? 'horizontally' : 'vertically'} at (${point.x}, ${point.y}).`,
          performed: { action: 'scroll', x: point.x, y: point.y, clicks, horizontal: args.horizontal === true },
        };
      }

      case 'type': {
        const text = args.text;
        if (typeof text !== 'string' || text.length === 0) throw new Error('type needs non-empty `text`');
        runtime.guardBeforeAction();
        const mode = args.newline === 'shiftEnter' ? 'shiftEnter' : 'enter';
        const lines = text.split(/\r\n|\r|\n/);
        let typed = 0;
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].length > 0) typed += helpers().win32.typeText(lines[index]);
          if (index + 1 < lines.length) {
            if (mode === 'shiftEnter') helpers().win32.keyDown('shift');
            try {
              helpers().win32.keyTap('enter');
            } finally {
              if (mode === 'shiftEnter') helpers().win32.keyUp('shift');
            }
            await wait(40);
          }
        }
        runtime.guardAfterAction();
        return {
          status: 'ok',
          message: `Typed ${typed} character(s) into the focused control.`,
          performed: { action: 'type', characters: typed, newlines: Math.max(0, lines.length - 1) },
        };
      }

      case 'shortcut': {
        if (typeof args.keys !== 'string' || args.keys.length === 0) {
          throw new Error('shortcut needs `keys`, e.g. "ctrl+shift+s"');
        }
        runtime.guardBeforeAction();
        const executed = helpers().win32.shortcut(args.keys);
        runtime.guardAfterAction();
        return { status: 'ok', message: `Pressed ${executed}.`, performed: { action: 'shortcut', keys: executed } };
      }

      case 'key': {
        if (typeof args.key !== 'string' || args.key.length === 0) {
          throw new Error('key needs a key name, e.g. "enter"');
        }
        const repeats = clampNumber(args.repeats, 1, 50, 1);
        runtime.guardBeforeAction();
        for (let index = 0; index < repeats; index += 1) {
          helpers().win32.keyTap(args.key);
          if (index + 1 < repeats) await wait(40);
        }
        runtime.guardAfterAction();
        return {
          status: 'ok',
          message: `Pressed ${args.key}${repeats > 1 ? ` ${repeats} times` : ''}.`,
          performed: { action: 'key', key: args.key, repeats },
        };
      }

      case 'wait_change':
      case 'wait_stable': {
        runtime.requireRead();
        const timeout = clampNumber(args.timeoutMs, 100, 120000, 5000);
        const interval = clampNumber(args.intervalMs, 30, 5000, 120);
        const tolerance = clampNumber(args.pixelTolerance, 0, 765, 24);
        const threshold = clampNumber(args.minChange, 0, 1, 0.002);
        const probeMax = clampNumber(args.probeMaxDimension, 64, 2048, 420);
        const started = Date.now();
        let previous = runtime.probe(args.region, probeMax);
        const baseline = previous;
        let lastChangeAt = started;
        let samples = 1;
        let ratio = 0;

        if (action === 'wait_change') {
          while (Date.now() - started < timeout) {
            await wait(interval);
            const frame = runtime.probe(args.region, probeMax);
            samples += 1;
            ratio = frameDifference(baseline, frame, tolerance);
            if (ratio >= threshold) {
              const elapsed = Date.now() - started;
              return {
                status: 'ok',
                changed: true,
                waitedMs: elapsed,
                changeRatio: Number(ratio.toFixed(5)),
                samples,
                message:
                  `Screen changed ${elapsed}ms after watching began (${(ratio * 100).toFixed(2)}% of sampled pixels ` +
                  'differ). The watcher is done: capture once now to see the new state.',
              };
            }
          }
          return {
            status: 'warning',
            changed: false,
            waitedMs: Date.now() - started,
            changeRatio: Number(ratio.toFixed(5)),
            samples,
            message:
              `Nothing changed in ${timeout}ms of watching (largest difference ${(ratio * 100).toFixed(2)}%). ` +
              'Do not capture in a loop; capture once to check, or wait longer with a bigger timeoutMs.',
          };
        }

        const quiet = clampNumber(args.quietMs, 50, 10000, 300);
        while (Date.now() - started < timeout) {
          await wait(interval);
          const frame = runtime.probe(args.region, probeMax);
          samples += 1;
          ratio = frameDifference(previous, frame, tolerance);
          previous = frame;
          if (ratio >= threshold) {
            lastChangeAt = Date.now();
          } else if (Date.now() - lastChangeAt >= quiet) {
            return {
              status: 'ok',
              stable: true,
              waitedMs: Date.now() - started,
              quietMs: quiet,
              samples,
              message: `Screen has been still for ${quiet}ms after ${samples} samples; it is settled, so one capture now shows the final state.`,
            };
          }
        }
        return {
          status: 'warning',
          stable: false,
          waitedMs: Date.now() - started,
          samples,
          message: `The screen was still changing after ${timeout}ms. It is animating or loading; raise timeoutMs or capture once and treat it as a moving target.`,
        };
      }

      case 'sleep': {
        const ms = clampNumber(args.sleep ?? args.ms, 0, 120000, 300);
        await wait(ms);
        return { status: 'ok', message: `Waited ${ms}ms.`, performed: { action: 'sleep', ms } };
      }

      case 'status': {
        const state = runtime.state();
        return {
          status: 'ok',
          message:
            `Screen reading: ${state.read ? 'ON' : 'OFF'}; desktop control: ${state.control ? 'ARMED' : 'OFF'}` +
            (state.emergencyStop ? `; EMERGENCY STOP (${state.stopReason ?? 'manual'}) — only the user can resume.` : '.') +
            ` Captures: ${state.stats.captures}, images attached: ${state.stats.images}, ` +
            `unchanged skipped: ${state.stats.unchanged}, rate-limited: ${state.stats.rateLimited}.`,
          gate: state,
        };
      }

      default:
        throw new Error(
          `unknown action ${JSON.stringify(action)}. Valid: info, windows, focus, capture, move, click, ` +
            'double_click, right_click, middle_click, drag, scroll, type, shortcut, key, wait_change, wait_stable, sleep, status.',
        );
    }
  }

  // -------------------------------------------------------------------------
  // Tool registration
  // -------------------------------------------------------------------------

  const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: true,
    properties: {
      status: { type: 'string', required: true, description: 'ok, warning, blocked, or stopped.' },
      message: { type: 'string', required: true, description: 'Outcome, coordinate rules, and any token-saving skip.' },
      images: {
        type: 'array',
        description: 'Captured images attached to this result, in order.',
        items: { type: 'object', additionalProperties: true },
      },
      screenshot: { type: 'object', additionalProperties: true },
      screen: { type: 'object', additionalProperties: true },
      cursor: { type: 'object', additionalProperties: true },
      windows: { type: 'array', items: { type: 'object', additionalProperties: true } },
      gate: { type: 'object', additionalProperties: true },
      performed: { type: 'object', additionalProperties: true },
      steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
      completed: { type: 'number' },
      total: { type: 'number' },
    },
  };

  /** Content blocks: text first, then every attached image. */
  function renderValue(value) {
    const blocks = [{ type: 'text', text: String(value?.message ?? 'done') }];
    for (const image of value?.images ?? []) blocks.push({ type: 'image', attachment: image.attachment });
    return blocks;
  }

  const COMMON_PARAMETERS = {
    action: {
      type: 'string',
      required: true,
      enum: [
        'info',
        'windows',
        'focus',
        'capture',
        'move',
        'click',
        'double_click',
        'right_click',
        'middle_click',
        'drag',
        'scroll',
        'type',
        'shortcut',
        'key',
        'wait_change',
        'wait_stable',
        'sleep',
        'status',
      ],
      description: 'Operation to perform.',
    },
    x: { type: 'number', description: 'Screen x in physical pixels.' },
    y: { type: 'number', description: 'Screen y in physical pixels.' },
    region: {
      type: 'object',
      additionalProperties: false,
      description: 'Area to capture or watch, in screen pixels. Prefer a small region over the whole desktop.',
      properties: {
        x: { type: 'number', required: true },
        y: { type: 'number', required: true },
        width: { type: 'number', required: true },
        height: { type: 'number', required: true },
      },
    },
    window: { type: 'string', description: 'Capture one window by title substring or numeric handle.' },
    maxDimension: {
      type: 'number',
      description: 'Longest side of the returned image. Omit unless you need a deliberately smaller or larger view.',
    },
    grid: { type: 'boolean', description: 'Draw a labelled screen-pixel ruler on the capture.' },
    force: { type: 'boolean', description: 'Attach the image even when the screen is unchanged (costs tokens).' },
    changeOnly: { type: 'boolean', description: 'Attach only the rectangle that changed since the last capture of that area.' },
    from: {
      type: 'object',
      additionalProperties: false,
      description: 'Drag start point.',
      properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
    },
    to: {
      type: 'object',
      additionalProperties: false,
      description: 'Drag end point.',
      properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
    },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for drag; defaults to left.' },
    clicks: { type: 'number', description: 'Wheel notches; positive up/away, negative down/toward. Default 3.' },
    horizontal: { type: 'boolean', description: 'Scroll horizontally.' },
    text: { type: 'string', description: 'Literal text to type; arbitrary Unicode (including CJK) is supported.' },
    keys: { type: 'string', description: 'Key chord, e.g. "ctrl+shift+s" or "alt+f4".' },
    key: { type: 'string', description: 'Single key, e.g. "enter", "escape", "tab", "f5", "left".' },
    repeats: { type: 'number', description: 'Times to repeat a key press. Default 1.' },
    title: { type: 'string', description: 'Window title substring for focus.' },
    handle: { type: 'string', description: 'Numeric window handle for focus.' },
    ensureForeground: {
      type: 'boolean',
      description: 'Raise the window under the pointer before clicking so Windows does not spend the click activating it. Default true.',
    },
    sleep: { type: 'number', description: 'Milliseconds to wait (sleep action, or before this action).' },
    timeoutMs: { type: 'number', description: 'wait_change/wait_stable: how long to watch. Default 5000.' },
    intervalMs: { type: 'number', description: 'wait_change/wait_stable: sampling interval. Default 120.' },
    quietMs: { type: 'number', description: 'wait_stable: how long the picture must stay unchanged. Default 300.' },
    minChange: { type: 'number', description: 'wait_change/wait_stable: fraction of pixels that must differ. Default 0.002.' },
    pixelTolerance: { type: 'number', description: 'wait_change/wait_stable: per-pixel RGB distance ignored as noise. Default 24.' },
  };

  /**
   * Register one tool, naming the instance in a failure.
   * @param tool - the definition built by `defineTool`.
   */
  function registerTool(tool) {
    try {
      ctx.tools.register(tool);
      ctx.logger?.info?.(`dsh-screen-use: registered \`${tool.name}\` (gates default OFF; open the floating panel to enable)`);
    } catch (error) {
      ctx.logger?.error?.(
        `dsh-screen-use: FAILED to register \`${tool.name}\`. Cause: ${error.message}. ` +
          'If this says "already registered", another row for this package is registering the same tool.',
      );
      throw error;
    }
  }

  registerTool(
    defineTool({
      name: 'screen',
      description: TOOL_DESCRIPTION,
      parameters: COMMON_PARAMETERS,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) },
      async execute(args) {
        const action = String(args?.action ?? '');
        try {
          if (args?.sleep !== undefined && action !== 'sleep' && action !== 'capture') await wait(args.sleep);
          return await runAction(action, args ?? {});
        } catch (error) {
          if (error instanceof ScreenGateError || error instanceof ScreenAbortError) return blocked(error);
          throw error;
        }
      },
    }),
  );

  registerTool(
    defineTool({
      name: 'screen_batch',
      description: BATCH_DESCRIPTION,
      parameters: {
        actions: {
          type: 'array',
          required: true,
          description: 'Ordered steps; each uses the same fields as the `screen` tool.',
          items: { type: 'object', additionalProperties: true, properties: COMMON_PARAMETERS },
        },
        captureAtEnd: { type: 'boolean', description: 'Attach one verification capture after the last step.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            status: { type: 'string', required: true },
            message: { type: 'string', required: true },
            completed: { type: 'number', required: true },
            total: { type: 'number', required: true },
            steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
            images: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => renderValue(value),
      },
      async execute(args) {
        const list = Array.isArray(args?.actions) ? args.actions : [];
        if (list.length === 0) throw new Error('screen_batch needs a non-empty `actions` array');
        if (list.length > 30) throw new Error('screen_batch accepts at most 30 actions per call; split the sequence.');
        const images = [];
        const steps = [];
        let failure = null;
        for (let index = 0; index < list.length; index += 1) {
          const step = list[index] ?? {};
          const action = String(step.action ?? '');
          try {
            const value = await runAction(action, step);
            for (const entry of value?.images ?? []) images.push(entry);
            steps.push({
              index,
              action,
              status: value?.status ?? 'ok',
              message: String(value?.message ?? 'ok').slice(0, 400),
            });
          } catch (error) {
            if (error instanceof ScreenGateError || error instanceof ScreenAbortError) {
              failure = { index, action, message: error.message };
              steps.push({ index, action, status: 'stopped', message: error.message });
              break;
            }
            failure = { index, action, message: error.message };
            steps.push({ index, action, status: 'failed', message: error.message });
            break;
          }
        }
        if (failure === null && args?.captureAtEnd === true) {
          try {
            const captured = await runAction('capture', { action: 'capture' });
            for (const entry of captured?.images ?? []) images.push(entry);
            steps.push({ index: list.length, action: 'capture', status: 'ok', message: String(captured?.message ?? '') });
          } catch (error) {
            steps.push({ index: list.length, action: 'capture', status: 'failed', message: error.message });
          }
        }
        const log = steps.map((step) => `${step.index}. ${step.action} [${step.status}] ${step.message}`).join('\n');
        return {
          status: failure === null ? 'ok' : 'failed',
          message: failure === null
            ? `Completed all ${list.length} step(s).\n${log}`
            : `Stopped at step ${failure.index} (${failure.action}): ${failure.message}\n${log}`,
          completed: failure === null ? steps.filter((step) => step.action !== 'capture').length : failure.index,
          total: list.length,
          steps,
          images,
        };
      },
    }),
  );

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    const order = systemPrompt.getSectionOrder?.('TOOL_COMPUTER_USE') ?? 3000;
    systemPrompt.section({ name: 'screen-use:policy', order, text: () => SYSTEM_POLICY });
  }

  // -------------------------------------------------------------------------
  // Panel routes
  // -------------------------------------------------------------------------

  /** Loopback authority keys accepted for a mutating request. */
  const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

  /** Normalize `host[:port]` to one loopback identity, or null. */
  function loopbackAuthority(authority) {
    try {
      const parsed = new URL(`http://${authority}`);
      if (!LOOPBACK.has(parsed.hostname.toLowerCase())) return null;
      return `loopback:${parsed.port === '' ? '80' : parsed.port}`;
    } catch {
      return null;
    }
  }

  /** Same-origin admission for the panel's mutating calls. */
  function isSameOrigin(request) {
    const host = request.headers.host;
    const hostKey = host === undefined ? null : loopbackAuthority(host);
    if (hostKey === null) return false;
    const origin = request.headers.origin;
    if (origin === undefined || origin === '') return true;
    try {
      const url = new URL(origin);
      if (url.protocol === 'dsh-app:') return true;
      return loopbackAuthority(url.host) === hostKey;
    } catch {
      return false;
    }
  }

  /** Answer one JSON body. */
  function sendJson(response, status, value) {
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(value));
  }

  /** Read a bounded JSON body. */
  async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > BODY_LIMIT_BYTES) throw new Error('request body too large');
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  /** Cached preview, so several viewers and fast polls share one capture. */
  let previewCache = { at: 0, png: null, width: 0, height: 0 };
  /** Panel GET count, for diagnosing whether the floating panel is mounted. */
  let panelPolls = 0;

  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = [
        host.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/state`,
          handler: async (request, response) => {
            if (request.method === 'GET') {
              panelPolls += 1;
              sendJson(response, 200, { ok: true, panelPolls, state: runtime.state() });
              return;
            }
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'GET, POST' });
              response.end();
              return;
            }
            if (!isSameOrigin(request)) {
              sendJson(response, 403, { error: 'untrusted origin' });
              return;
            }
            let body;
            try {
              body = await readJsonBody(request);
            } catch (error) {
              sendJson(response, 400, { error: error.message });
              return;
            }
            try {
              if (body?.stop === true) {
                runtime.stop('panel');
              } else if (body?.resume === true) {
                if (body.read !== undefined) runtime.setRead(body.read);
                runtime.setControl(true, { resume: true });
              } else {
                if (body?.read !== undefined) runtime.setRead(body.read);
                if (body?.control !== undefined) runtime.setControl(body.control);
              }
              sendJson(response, 200, { ok: true, state: runtime.state() });
            } catch (error) {
              if (error instanceof ScreenGateError) {
                sendJson(response, 409, {
                  ok: false,
                  error: error.message,
                  needsResume: runtime.state().emergencyStop,
                  state: runtime.state(),
                });
                return;
              }
              sendJson(response, 500, { ok: false, error: error.message, state: runtime.state() });
            }
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/preview`,
          handler: (request, response) => {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' });
              response.end();
              return;
            }
            try {
              runtime.requireRead();
              if (previewCache.png !== null && Date.now() - previewCache.at < 1500) {
                response.writeHead(200, {
                  'cache-control': 'no-store',
                  'content-type': 'image/png',
                  'content-length': String(previewCache.png.length),
                });
                response.end(previewCache.png);
                return;
              }
              const { png, meta } = runtime.capture({ maxDimension: 560, force: true }, { gated: false, preview: true });
              if (png === null) {
                response.writeHead(204, { 'cache-control': 'no-store' });
                response.end();
                return;
              }
              previewCache = { at: Date.now(), png, width: meta.width, height: meta.height };
              response.writeHead(200, {
                'cache-control': 'no-store',
                'content-type': 'image/png',
                'content-length': String(png.length),
              });
              response.end(png);
            } catch (error) {
              sendJson(response, error instanceof ScreenGateError ? 409 : 500, { error: error.message });
            }
          },
        }),
      ];
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-screen-use: panel routes');
  });

  ctx.logger?.info?.(
    `dsh-screen-use: ready — gates OFF, captures -> ${runtime.captureDirectory()}, ` +
      `overview cap ${config.overviewMaxDimension}px, native cap ${config.nativeMaxDimension}px`,
  );
}

module.exports = { name, inject, Config, apply };
