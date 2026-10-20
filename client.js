/**
 * dsh-screen-use — browser half: the floating control panel.
 *
 * Three things live here, and each exists for a reason the request named:
 *
 * 1. Two switches. 「读取屏幕」 is the token switch: while it is OFF the plugin
 *    captures nothing, previews nothing, and every screen tool call is refused.
 *    「允许操作」 is the input switch; while it is OFF no mouse or keyboard event
 *    can be synthesized. Both default OFF and are never persisted.
 * 2. The chat box. It sends to the session that is currently open in the main
 *    view through the client `sessions` service — the same `prompt()` call the
 *    shipped composer makes — so the agent that answers here is the one that can
 *    operate the desktop.
 * 3. The stop. A big red control that halts injection immediately, plus the
 *    banner that appears after Escape or a mouse takeover. Only this panel can
 *    clear that stop; no model-reachable path can.
 *
 * Styling is the host's: only `--dsw-alias-*` tokens are referenced, controls
 * mirror the shipped switch/button shapes, and the card opts back into pointer
 * events because `shell.overlay` is a click-through layer.
 */

window.__ModuleLoader__.load({
  id: 'dsh-screen-use',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useLayoutEffect, useRef, useState } = React;
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'screenUse';
    /** Frame-wide floating layer; entries opt back into pointer events. */
    const SLOT = 'shell.overlay';
    /** This bundle's host route namespace. */
    const ROUTE = '/dsh-screen-use';
    /** Class prefix, so copied host styles cannot collide with the app. */
    const CLS = 'dssu';
    /** Where the panel's position is remembered between page reloads. */
    const POSITION_KEY = 'dsh-screen-use.panel.position';
    /** First-run position: top-left of the conversation, clear of the sidebar. */
    const DEFAULT_POSITION = Object.freeze({ x: 280, y: 84 });
    /** Movement (px) before a press counts as a drag rather than a click. */
    const DRAG_THRESHOLD = 4;
    /** How much of the panel must stay on screen, so it can never be lost. */
    const VISIBLE_MIN = 72;

    /**
     * Keep the panel reachable: at least {@link VISIBLE_MIN}px of it stays inside
     * the viewport on both axes. Without this, a drag can park the panel outside
     * the window where no pointer can reach it again.
     * @param position - requested `{x, y}` in CSS pixels.
     * @param width - panel width in CSS pixels.
     * @returns a clamped position.
     */
    function clampPanelPosition(position, width) {
      const w = Math.max(240, Math.min(width ?? 360, window.innerWidth - 16));
      const maxX = window.innerWidth - VISIBLE_MIN;
      const minX = -(w - VISIBLE_MIN);
      const maxY = window.innerHeight - VISIBLE_MIN;
      const minY = 8;
      return {
        x: Math.min(maxX, Math.max(minX, Math.round(position.x))),
        y: Math.min(maxY, Math.max(minY, Math.round(position.y))),
      };
    }

    /** @returns a stored position, or null when none is usable. */
    function loadStoredPosition() {
      try {
        const raw = window.localStorage.getItem(POSITION_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed?.x !== 'number' || typeof parsed?.y !== 'number') return null;
        return clampPanelPosition(parsed, 360);
      } catch {
        return null;
      }
    }

    const zh = {
      'title': '屏幕操作',
      'subtitle': '可同时操作 · Esc 急停',
      'open': '打开屏幕操作面板',
      'close': '收起面板',
      'minimize': '最小化',
      'reading': '读取屏幕',
      'reading.on': '开启后才会截图；关闭时零截图、零预览',
      'reading.off': '已关闭：不截图、不预览，节省 token',
      'control': '允许操作',
      'control.on': '开启后 DeepSeek 可移动鼠标、点击与输入；你也能同时操作，按 Esc 强制停止',
      'control.off': '已关闭：鼠标键盘注入被阻止',
      'status.idle': '待命',
      'status.armed': '操作已授权',
      'status.stopped': '已急停',
      'status.reading': '正在读取屏幕',
      'stop': '立即停止操作',
      'stopped.title': '已强制停止',
      'stopped.esc': '你按下了 Esc，鼠标键盘注入已被阻断。',
      'stopped.user': '检测到你亲自移动/点击了鼠标，自动化已让出控制。',
      'stopped.panel': '你从面板停止了操作。',
      'stopped.other': '操作已被停止。',
      'resume': '解除急停并继续',
      'preview.empty': '开启「读取屏幕」后可在这里实时查看屏幕',
      'preview.failed': '屏幕预览暂时不可用',
      'preview.refresh': '刷新预览',
      'preview.auto': '每 4 秒自动刷新',
      'chat.title': '对 DeepSeek 说',
      'chat.placeholder': '让 DeepSeek 帮你操作，例如「打开设置，把字体调大」',
      'chat.send': '发送',
      'chat.sending': '发送中…',
      'chat.working': 'DeepSeek 正在处理…',
      'chat.noSession': '先在主界面打开一个会话，消息才会发得出去。',
      'chat.sentTo': '发送到「{title}」',
      'chat.needReading': '提示：屏幕读取已关闭，DeepSeek 现在看不到屏幕。',
      'chat.needControl': '提示：允许操作已关闭，DeepSeek 只能看到不能动手。',
      'chat.you': '你',
      'chat.assistant': 'DeepSeek',
      'chat.latest': '最近回复',
      'chat.error': '发送失败：{message}',
      'chat.hint': 'Enter 发送 · Shift+Enter 换行',
      'chat.empty': '还没有消息。这里的消息会进入当前会话。',
      'token.note': '省 token：整屏会缩到 1024px 内，画面没变就不再发第二张图。',
      'toggle.failed': '切换失败：{message}',
      'drag': '拖动面板 · 双击复位',
      'hidden.show': '显示屏幕操作面板',
    };

    const en = {
      'title': 'Screen use',
      'subtitle': 'Shared control · Esc to stop',
      'open': 'Open the screen-use panel',
      'close': 'Hide the panel',
      'minimize': 'Minimize',
      'reading': 'Read screen',
      'reading.on': 'Captures only while on; off means no capture and no preview',
      'reading.off': 'Off: nothing is captured or previewed',
      'control': 'Allow control',
      'control.on': 'DeepSeek may move the pointer, click and type; you can use the mouse too — Esc stops it',
      'control.off': 'Off: all mouse and keyboard injection is blocked',
      'status.idle': 'Idle',
      'status.armed': 'Control armed',
      'status.stopped': 'Stopped',
      'status.reading': 'Reading screen',
      'stop': 'Stop control now',
      'stopped.title': 'Stopped',
      'stopped.esc': 'You pressed Escape; mouse and keyboard injection is blocked.',
      'stopped.user': 'You moved or clicked the mouse yourself, so the automation yielded.',
      'stopped.panel': 'You stopped control from the panel.',
      'stopped.other': 'Control was stopped.',
      'resume': 'Clear stop and continue',
      'preview.empty': 'Turn on “Read screen” to see a live preview here',
      'preview.failed': 'Screen preview is unavailable',
      'preview.refresh': 'Refresh preview',
      'preview.auto': 'Refreshes every 4s',
      'chat.title': 'Tell DeepSeek',
      'chat.placeholder': 'Ask DeepSeek to operate, e.g. “open Settings and make the font larger”',
      'chat.send': 'Send',
      'chat.sending': 'Sending…',
      'chat.working': 'DeepSeek is working…',
      'chat.noSession': 'Open a session in the main view first; the message needs somewhere to go.',
      'chat.sentTo': 'Sent to “{title}”',
      'chat.needReading': 'Heads-up: reading is off, so DeepSeek cannot see the screen.',
      'chat.needControl': 'Heads-up: control is off, so DeepSeek can look but cannot act.',
      'chat.you': 'You',
      'chat.assistant': 'DeepSeek',
      'chat.latest': 'Latest reply',
      'chat.error': 'Send failed: {message}',
      'chat.hint': 'Enter to send · Shift+Enter for a newline',
      'chat.empty': 'No messages yet. Messages here go to the current session.',
      'token.note': 'Token guard: full-screen captures are capped at 1024px, and an unchanged screen is never sent twice.',
      'toggle.failed': 'Switch failed: {message}',
      'drag': 'Drag panel · double-click to reset',
      'hidden.show': 'Show the screen-use panel',
    };

    // -----------------------------------------------------------------------
    // Small pieces
    // -----------------------------------------------------------------------

    /** Parse a server response, surfacing its `error` text on failure. */
    async function readJson(response) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const message = body?.error ?? `HTTP ${response.status}`;
        const error = new Error(message);
        error.body = body;
        throw error;
      }
      return body;
    }

    /** The host face this half calls: state, switches, preview URL, chat. */
    function hostCalls(ctx) {
      const state = async () => readJson(await fetch(`${ROUTE}/state`, { credentials: 'same-origin', cache: 'no-store' }));

      const post = async (body) =>
        readJson(
          await fetch(`${ROUTE}/state`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );

      /** Send one message to the session the main view currently shows. */
      const send = async (sessionId, text) => {
        const binding = ctx.sessions.binding(sessionId);
        if (binding === undefined) throw new Error('session is not retained');
        const result = await binding.session.prompt([{ type: 'text', text }], 'queue');
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      };

      /**
       * Watch for the next finalized assistant message after `afterSeq`.
       * Returns an unsubscribe function; the callback receives its text.
       */
      const watchAssistant = (sessionId, afterSeq, onText) => {
        const binding = ctx.sessions.binding(sessionId);
        if (binding === undefined) return () => {};
        const extract = (entries) => {
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            if (entry.type !== 'event') continue;
            const event = entry.event;
            if (event.type !== 'assistant/message') continue;
            if (typeof event.seq === 'number' && afterSeq !== undefined && event.seq <= afterSeq) continue;
            const content = event.data?.message?.content;
            if (!Array.isArray(content)) continue;
            const text = content
              .filter((block) => block?.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join('\n')
              .trim();
            if (text.length > 0) return text;
          }
          return null;
        };
        const read = () => {
          const text = extract(binding.eventSource.getSnapshot().entries);
          if (text !== null) onText(text);
        };
        const unsubscribe = binding.eventSource.subscribe(read);
        read();
        return unsubscribe;
      };

      /** The last event sequence currently loaded, used as a watcher baseline. */
      const tailSeq = (sessionId) => {
        const binding = ctx.sessions.binding(sessionId);
        if (binding === undefined) return undefined;
        const entries = binding.eventSource.getSnapshot().entries;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index];
          if (typeof entry.event?.seq === 'number') return entry.event.seq;
        }
        return undefined;
      };

      return { state, post, send, watchAssistant, tailSeq };
    }

    /** Stable injectable props for one registration. */
    function panelHost(ctx) {
      const calls = hostCalls(ctx);
      return {
        readGates: () => calls.state(),
        writeGates: (body) => calls.post(body),
        sendPrompt: (sessionId, text) => calls.send(sessionId, text),
        watchAssistant: (sessionId, afterSeq, onText) => calls.watchAssistant(sessionId, afterSeq, onText),
        tailSeq: (sessionId) => calls.tailSeq(sessionId),
      };
    }

    /** Current session id: the one the main view retains. */
    function currentSessionId(useSessions) {
      return useSessions((state) =>
        Object.values(state.byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id,
      );
    }

    /** A switch styled after the host's, with `role="switch"`. */
    function Toggle({ checked, disabled, label, description, onChange }) {
      return h('div', { className: `${CLS}-switchRow` }, [
        h('div', { key: 'text', className: `${CLS}-switchText` }, [
          h('div', { key: 'label', className: `${CLS}-switchLabel` }, label),
          description === undefined ? null : h('div', { key: 'desc', className: `${CLS}-switchDesc` }, description),
        ]),
        h(
          'button',
          {
            key: 'switch',
            type: 'button',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': label,
            className: `${CLS}-switch`,
            'data-on': checked ? 'yes' : 'no',
            disabled,
            onClick: () => onChange(!checked),
          },
          h('span', { className: `${CLS}-knob`, 'aria-hidden': true }),
        ),
      ]);
    }

    /** One message bubble. */
    function Bubble({ role, label, text }) {
      return h('div', { className: `${CLS}-bubble`, 'data-role': role }, [
        h('div', { key: 'label', className: `${CLS}-bubbleLabel` }, label),
        h('div', { key: 'text', className: `${CLS}-bubbleText` }, text),
      ]);
    }

    // -----------------------------------------------------------------------
    // Panel
    // -----------------------------------------------------------------------

    /**
     * The floating panel.
     * @param props - slot props plus this plugin's injected host face.
     */
    function ScreenUsePanel(props) {
      const { t, useSessions, readGates, writeGates, sendPrompt, watchAssistant, tailSeq } = props;

      const sessionId = currentSessionId(useSessions);
      const session = useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]));
      const running = session?.running === true;

      const [expanded, setExpanded] = useState(false);
      const [hidden, setHidden] = useState(false);
      const [gates, setGates] = useState(null);
      const [gateError, setGateError] = useState(null);
      const [previewTick, setPreviewTick] = useState(0);
      const [previewError, setPreviewError] = useState(false);
      const [draft, setDraft] = useState('');
      const [sending, setSending] = useState(false);
      const [chatError, setChatError] = useState(null);
      const [sent, setSent] = useState(null);
      const [reply, setReply] = useState(null);
      const [lastSent, setLastSent] = useState(null);
      const [position, setPosition] = useState(loadStoredPosition);
      const [dragging, setDragging] = useState(false);

      const dockRef = useRef(null);
      const dragState = useRef(null);
      const watchRef = useRef(null);
      const suppressClick = useRef(false);

      // -- gates -------------------------------------------------------------

      const refresh = useCallback(async () => {
        try {
          const body = await readGates();
          setGates(body.state);
          setGateError(null);
        } catch (error) {
          setGateError(error.message);
        }
      }, [readGates]);

      useEffect(() => {
        void refresh();
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') void refresh();
        }, 2500);
        return () => clearInterval(timer);
      }, [refresh]);

      const applyGates = useCallback(
        async (body) => {
          setGateError(null);
          try {
            const response = await writeGates(body);
            setGates(response.state);
          } catch (error) {
            if (error.body?.state !== undefined) setGates(error.body.state);
            setGateError(error.message);
          }
        },
        [writeGates],
      );

      const readOn = gates?.read === true;
      const controlOn = gates?.control === true;
      const stopped = gates?.emergencyStop === true;

      // -- preview -----------------------------------------------------------

      useEffect(() => {
        if (!expanded || !readOn) return undefined;
        setPreviewTick((value) => value + 1);
        const timer = setInterval(() => setPreviewTick((value) => value + 1), 4000);
        return () => clearInterval(timer);
      }, [expanded, readOn]);

      useEffect(() => {
        setPreviewError(false);
      }, [previewTick]);

      // -- stop watching when the session changes ----------------------------

      useEffect(() => {
        return () => {
          if (watchRef.current !== null) {
            watchRef.current();
            watchRef.current = null;
          }
        };
      }, [sessionId]);

      // -- position & drag ---------------------------------------------------

      // Remember the spot the user chose. This is a pure UI preference, so it
      // belongs in the page's own storage: reloading or toggling the plugin must
      // not send the panel back to a corner the user already moved it away from.
      useEffect(() => {
        try {
          if (position === null) window.localStorage.removeItem(POSITION_KEY);
          else window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
        } catch {
          // Storage can be unavailable; the position then lives for this page only.
        }
      }, [position]);

      // A window resize can leave a saved position outside the new viewport.
      useEffect(() => {
        const onResize = () => {
          setPosition((current) =>
            current === null ? null : clampPanelPosition(current, dockRef.current?.offsetWidth ?? 360),
          );
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      // Expanding near the bottom edge must pull the card back into view: the
      // pill is small enough to sit anywhere, but the card is up to ~620px tall.
      // A layout effect measures the real card height before paint; a rAF would
      // run after the oversized card had already flashed.
      useLayoutEffect(() => {
        if (!expanded) return undefined;
        /**
         * Pull an oversized card back inside the viewport. Runs twice because
         * the first pass happens before the preview image has loaded, when the
         * card is still shorter than its final height.
         */
        const clampIntoView = () => {
          if (dragState.current !== null) return;
          const element = dockRef.current;
          if (element === null) return;
          const rect = element.getBoundingClientRect();
          const maxLeft = Math.max(8, window.innerWidth - Math.min(rect.width, window.innerWidth - 16) - 8);
          const maxTop = Math.max(8, window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8);
          if (rect.left <= maxLeft && rect.top <= maxTop && rect.bottom <= window.innerHeight + 1) return;
          setPosition(clampPanelPosition({ x: Math.min(rect.left, maxLeft), y: Math.min(rect.top, maxTop) }, rect.width));
        };
        clampIntoView();
        const timer = window.setTimeout(clampIntoView, 450);
        return () => window.clearTimeout(timer);
      }, [expanded]);

      useEffect(() => {
        if (!dragging) return undefined;
        const move = (event) => {
          const drag = dragState.current;
          if (drag === null) return;
          const dx = event.clientX - drag.pointerX;
          const dy = event.clientY - drag.pointerY;
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) drag.moved = true;
          if (!drag.moved) return;
          setPosition(clampPanelPosition({ x: drag.startX + dx, y: drag.startY + dy }, drag.width));
        };
        const finish = () => {
          const drag = dragState.current;
          dragState.current = null;
          setDragging(false);
          if (drag?.moved === true) {
            // A drag that ends over the pill must not also count as the click
            // that expands it; the browser fires `click` after `pointerup`.
            suppressClick.current = true;
            window.setTimeout(() => {
              suppressClick.current = false;
            }, 350);
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
        };
      }, [dragging]);

      /**
       * Start dragging from a press.
       *
       * The whole card is grabbable except its real controls, and the collapsed
       * pill is grabbable too — otherwise a minimised panel could never be moved.
       * @param event - the pointerdown.
       * @param options - `{ fromHandle }` skips the interactive-target test for
       *   the pill, which *is* a button.
       */
      const beginDrag = useCallback((event, options = {}) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (options.fromHandle !== true) {
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest('button, a, input, textarea, select, [role="switch"], [data-no-drag]') !== null
          ) {
            return;
          }
        }
        const rect = dockRef.current?.getBoundingClientRect();
        const origin = position ?? DEFAULT_POSITION;
        dragState.current = {
          pointerX: event.clientX,
          pointerY: event.clientY,
          startX: rect?.left ?? origin.x,
          startY: rect?.top ?? origin.y,
          width: rect?.width ?? 360,
          moved: false,
        };
        if (rect !== null && rect !== undefined) setPosition({ x: rect.left, y: rect.top });
        setDragging(true);
        event.preventDefault();
      }, [position]);

      /** Put the panel back where it starts, for a panel dragged out of reach. */
      const resetPosition = useCallback(() => {
        setPosition(null);
      }, []);

      // -- chat --------------------------------------------------------------

      const send = useCallback(async () => {
        const text = draft.trim();
        if (text.length === 0 || sending) return;
        if (sessionId === undefined) {
          setChatError(t('chat.noSession'));
          return;
        }
        setSending(true);
        setChatError(null);
        setReply(null);
        if (watchRef.current !== null) {
          watchRef.current();
          watchRef.current = null;
        }
        // Read the baseline BEFORE prompting: the answer is the first assistant
        // message after it, while anything already in the log is history.
        const baseline = tailSeq(sessionId);
        try {
          await sendPrompt(sessionId, text);
          setDraft('');
          setLastSent({ text, at: Date.now(), title: session?.displayTitle ?? session?.title ?? sessionId });
          setSent(t('chat.sentTo', { title: session?.displayTitle ?? session?.title ?? sessionId }));
          watchRef.current = watchAssistant(sessionId, baseline, (assistantText) => setReply(assistantText));
        } catch (error) {
          setChatError(t('chat.error', { message: error.message }));
        } finally {
          setSending(false);
        }
      }, [draft, sending, sessionId, sendPrompt, watchAssistant, tailSeq, session, t]);

      // -- render ------------------------------------------------------------

      const corner = clampPanelPosition(position ?? DEFAULT_POSITION, dockRef.current?.offsetWidth ?? 360);

      /**
       * Wrap a dock button's click so the click that ends a drag is swallowed.
       * @param action - what the click should do when it was a real click.
       * @returns the click handler.
       */
      const dockClick = (action) => () => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        action();
      };

      if (hidden) {
        return h(
          'div',
          {
            className: `${CLS}-dock`,
            ref: dockRef,
            style: { left: corner.x, top: corner.y },
            'data-dragging': dragging ? 'yes' : 'no',
          },
          h(
            'button',
            {
              type: 'button',
              className: `${CLS}-fab`,
              title: t('hidden.show'),
              'aria-label': t('hidden.show'),
              onPointerDown: (event) => beginDrag(event, { fromHandle: true }),
              onClick: dockClick(() => {
                setHidden(false);
                setExpanded(true);
              }),
            },
            [h('span', { key: 'dot', className: `${CLS}-fabDot`, 'data-state': stopped ? 'stopped' : controlOn ? 'armed' : 'idle' }), t('title')],
          ),
        );
      }

      if (!expanded) {
        return h(
          'div',
          {
            className: `${CLS}-dock`,
            ref: dockRef,
            style: { left: corner.x, top: corner.y },
            'data-dragging': dragging ? 'yes' : 'no',
          },
          h(
            'button',
            {
              type: 'button',
              className: `${CLS}-pill`,
              title: t('open'),
              'aria-label': t('open'),
              onPointerDown: (event) => beginDrag(event, { fromHandle: true }),
              onClick: dockClick(() => setExpanded(true)),
            },
            [
              h('span', {
                key: 'dot',
                className: `${CLS}-dot`,
                'data-state': stopped ? 'stopped' : controlOn ? 'armed' : readOn ? 'reading' : 'idle',
                'aria-hidden': true,
              }),
              h('span', { key: 'label', className: `${CLS}-pillLabel` }, t('title')),
            ],
          ),
        );
      }

      const statusText = stopped
        ? t('status.stopped')
        : controlOn
          ? t('status.armed')
          : readOn
            ? t('status.reading')
            : t('status.idle');

      const stopReasonKey = gates?.stopReason === 'esc'
        ? 'stopped.esc'
        : gates?.stopReason === 'user-input'
          ? 'stopped.user'
          : gates?.stopReason === 'panel'
            ? 'stopped.panel'
            : 'stopped.other';

      return h(
        'div',
        {
          className: `${CLS}-dock`,
          ref: dockRef,
          style: { left: corner.x, top: corner.y },
          'data-dragging': dragging ? 'yes' : 'no',
        },
        h(
          'div',
          {
            className: `${CLS}-card`,
            role: 'region',
            'aria-label': t('title'),
            'data-dragging': dragging ? 'yes' : 'no',
            onPointerDown: (event) => beginDrag(event),
          },
          [
            // header ------------------------------------------------------
            h('div', {
              key: 'header',
              className: `${CLS}-header`,
              title: t('drag'),
              onDoubleClick: resetPosition,
            }, [
              h('span', {
                key: 'dot',
                className: `${CLS}-dot`,
                'data-state': stopped ? 'stopped' : controlOn ? 'armed' : readOn ? 'reading' : 'idle',
                'aria-hidden': true,
              }),
              h('div', { key: 'titles', className: `${CLS}-titles` }, [
                h('div', { key: 'title', className: `${CLS}-title` }, t('title')),
                h('div', { key: 'sub', className: `${CLS}-subtitle` }, `${statusText} · ${t('subtitle')}`),
              ]),
              h('button', {
                key: 'min',
                type: 'button',
                className: `${CLS}-iconBtn`,
                title: t('minimize'),
                'aria-label': t('minimize'),
                onPointerDown: (event) => event.stopPropagation(),
                onClick: () => setExpanded(false),
              }, '—'),
              h('button', {
                key: 'close',
                type: 'button',
                className: `${CLS}-iconBtn`,
                title: t('close'),
                'aria-label': t('close'),
                onPointerDown: (event) => event.stopPropagation(),
                onClick: () => {
                  setHidden(true);
                  setExpanded(false);
                },
              }, '×'),
            ]),

            // body --------------------------------------------------------
            h('div', { key: 'body', className: `${CLS}-body` }, [
              stopped
                ? h('div', { key: 'stopBanner', className: `${CLS}-stopBanner`, role: 'alert' }, [
                    h('div', { key: 't', className: `${CLS}-stopTitle` }, t('stopped.title')),
                    h('div', { key: 'r', className: `${CLS}-stopText` }, t(stopReasonKey)),
                    h('button', {
                      key: 'resume',
                      type: 'button',
                      className: `${CLS}-btn`,
                      'data-variant': 'solid-danger',
                      onClick: () => void applyGates({ resume: true, read: readOn }),
                    }, t('resume')),
                  ])
                : null,

              h('div', { key: 'switches', className: `${CLS}-switches` }, [
                h(Toggle, {
                  key: 'read',
                  checked: readOn,
                  disabled: gates === null,
                  label: t('reading'),
                  description: readOn ? t('reading.on') : t('reading.off'),
                  onChange: (next) => void applyGates({ read: next }),
                }),
                h(Toggle, {
                  key: 'control',
                  checked: controlOn,
                  disabled: gates === null || stopped,
                  label: t('control'),
                  description: controlOn ? t('control.on') : t('control.off'),
                  onChange: (next) => void applyGates({ control: next }),
                }),
              ]),

              gateError === null
                ? null
                : h('div', { key: 'gateError', className: `${CLS}-error`, role: 'status' }, t('toggle.failed', { message: gateError })),

              h('div', { key: 'preview', className: `${CLS}-preview` }, readOn
                ? h('div', { className: `${CLS}-previewFrame` }, [
                    h('img', {
                      key: 'img',
                      className: `${CLS}-previewImg`,
                      src: `${ROUTE}/preview?t=${previewTick}`,
                      alt: t('reading'),
                      draggable: false,
                      onError: () => setPreviewError(true),
                      onLoad: () => setPreviewError(false),
                    }),
                    h('button', {
                      key: 'refresh',
                      type: 'button',
                      className: `${CLS}-previewRefresh`,
                      title: t('preview.refresh'),
                      'aria-label': t('preview.refresh'),
                      onClick: () => setPreviewTick((value) => value + 1),
                    }, '⟳'),
                    h('span', { key: 'auto', className: `${CLS}-previewHint` }, previewError ? t('preview.failed') : t('preview.auto')),
                  ])
                : h('div', { className: `${CLS}-previewEmpty` }, t('preview.empty'))),

              h('div', { key: 'note', className: `${CLS}-note` }, t('token.note')),

              controlOn
                ? h('button', {
                    key: 'stop',
                    type: 'button',
                    className: `${CLS}-stopButton`,
                    onClick: () => void applyGates({ stop: true }),
                  }, t('stop'))
                : null,

              // chat ------------------------------------------------------
              h('div', { key: 'chat', className: `${CLS}-chat` }, [
                h('div', { key: 'chatHead', className: `${CLS}-chatHead` }, [
                  h('span', { key: 'label', className: `${CLS}-chatTitle` }, t('chat.title')),
                  session === undefined
                    ? null
                    : h('span', { key: 'target', className: `${CLS}-chatTarget`, title: session.displayTitle ?? session.title }, session.displayTitle ?? session.title),
                ]),

                session === undefined
                  ? h('div', { key: 'noSession', className: `${CLS}-chatEmpty` }, t('chat.noSession'))
                  : null,

                lastSent === null
                  ? h('div', { key: 'empty', className: `${CLS}-chatEmpty` }, t('chat.empty'))
                  : h(Bubble, { key: 'lastSent', role: 'user', label: t('chat.you'), text: lastSent.text }),

                reply === null
                  ? null
                  : h(Bubble, { key: 'reply', role: 'assistant', label: `${t('chat.assistant')} · ${t('chat.latest')}`, text: reply }),

                running
                  ? h('div', { key: 'running', className: `${CLS}-running`, role: 'status' }, t('chat.working'))
                  : null,

                chatError === null
                  ? null
                  : h('div', { key: 'chatError', className: `${CLS}-error`, role: 'status' }, chatError),

                sent === null || chatError !== null
                  ? null
                  : h('div', { key: 'sent', className: `${CLS}-sent` }, sent),

                session === undefined
                  ? null
                  : h('div', { key: 'hints', className: `${CLS}-hints` }, [
                      readOn ? null : h('div', { key: 'r', className: `${CLS}-hintWarn` }, t('chat.needReading')),
                      controlOn ? null : h('div', { key: 'c', className: `${CLS}-hintWarn` }, t('chat.needControl')),
                    ]),

                h('div', { key: 'composer', className: `${CLS}-composer` }, [
                  h('textarea', {
                    key: 'input',
                    className: `${CLS}-input`,
                    value: draft,
                    rows: 2,
                    placeholder: t('chat.placeholder'),
                    disabled: session === undefined,
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                        event.preventDefault();
                        void send();
                      }
                    },
                  }),
                  h('div', { key: 'row', className: `${CLS}-composerRow` }, [
                    h('span', { key: 'hint', className: `${CLS}-composerHint` }, t('chat.hint')),
                    h('button', {
                      key: 'send',
                      type: 'button',
                      className: `${CLS}-send`,
                      disabled: session === undefined || sending || draft.trim().length === 0,
                      onClick: () => void send(),
                    }, sending ? t('chat.sending') : t('chat.send')),
                  ]),
                ]),
              ]),
            ]),
          ],
        ),
      );
    }

    // -----------------------------------------------------------------------
    // Styles
    // -----------------------------------------------------------------------

    /** Install the plugin's stylesheet; returns the tag for disposal. */
    function ensureStyles() {
      const id = 'dsh-screen-use-styles';
      const existing = document.getElementById(id);
      if (existing !== null) existing.remove();
      const tag = document.createElement('style');
      tag.id = id;
      tag.textContent = `
.${CLS}-dock{position:fixed;z-index:12000;pointer-events:none;font-family:inherit;color:var(--dsw-alias-label-primary)}
.${CLS}-dock[data-dragging="yes"]{user-select:none;-webkit-user-select:none}
.${CLS}-dock[data-dragging="yes"] .${CLS}-card,.${CLS}-dock[data-dragging="yes"] .${CLS}-pill,.${CLS}-dock[data-dragging="yes"] .${CLS}-fab{cursor:grabbing}
.${CLS}-card{pointer-events:auto;width:360px;max-height:min(620px,calc(100vh - 40px));display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay,#fff);border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.18);overflow:hidden;backdrop-filter:blur(12px)}
.${CLS}-card[data-dragging="yes"]{box-shadow:0 18px 52px rgba(0,0,0,.26)}
.${CLS}-header{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:grab;user-select:none;border-bottom:.5px solid var(--dsw-alias-border-l1);touch-action:none}
.${CLS}-card[data-dragging="yes"] .${CLS}-header{cursor:grabbing}
.${CLS}-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.${CLS}-dot[data-state="reading"]{background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.${CLS}-dot[data-state="armed"]{background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 20%,transparent)}
.${CLS}-dot[data-state="stopped"]{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,transparent)}
.${CLS}-titles{flex:1;min-width:0}
.${CLS}-title{font-size:13px;font-weight:600;line-height:18px}
.${CLS}-subtitle{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${CLS}-iconBtn{flex:none;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer}
.${CLS}-iconBtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.${CLS}-body{padding:10px 12px 12px;overflow:auto;display:flex;flex-direction:column;gap:10px}
.${CLS}-switches{display:flex;flex-direction:column;gap:8px}
.${CLS}-switchRow{display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:10px}
.${CLS}-switchText{flex:1;min-width:0}
.${CLS}-switchLabel{font-size:12.5px;font-weight:600;line-height:17px}
.${CLS}-switchDesc{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.${CLS}-switch{flex:none;width:34px;height:20px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-state-idle-primary);position:relative;cursor:pointer;transition:background .16s ease;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent)}
.${CLS}-switch[data-on="yes"]{background:var(--dsw-alias-brand-primary)}
.${CLS}-switch:disabled{opacity:.5;cursor:default}
.${CLS}-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .16s ease;box-shadow:0 0 0 1px rgba(0,0,0,.28),0 1px 2px rgba(0,0,0,.4)}
.${CLS}-switch[data-on="yes"] .${CLS}-knob{transform:translateX(14px)}
.${CLS}-stopBanner{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.${CLS}-stopTitle{font-size:12.5px;font-weight:700;color:var(--dsw-alias-state-error-primary)}
.${CLS}-stopText{font-size:11.5px;line-height:16px}
.${CLS}-stopButton{width:100%;padding:8px 10px;border-radius:9px;border:.5px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12.5px;font-weight:700;cursor:pointer}
.${CLS}-stopButton:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}
.${CLS}-btn{padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;align-self:flex-start}
.${CLS}-btn[data-variant="solid-danger"]{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff;font-weight:600}
.${CLS}-preview{border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.${CLS}-previewFrame{position:relative;line-height:0}
.${CLS}-previewImg{display:block;width:100%;height:auto;max-height:180px;object-fit:contain;background:var(--dsw-alias-bg-layer-2)}
.${CLS}-previewRefresh{position:absolute;top:6px;right:6px;width:24px;height:24px;border:0;border-radius:7px;background:rgba(0,0,0,.45);color:#fff;cursor:pointer;font-size:13px;line-height:24px;text-align:center}
.${CLS}-previewHint{position:absolute;left:6px;bottom:6px;padding:2px 6px;border-radius:6px;background:rgba(0,0,0,.45);color:#fff;font-size:10px;line-height:14px}
.${CLS}-previewEmpty{padding:14px 12px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);text-align:center}
.${CLS}-note{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-secondary);padding:0 2px}
.${CLS}-chat{display:flex;flex-direction:column;gap:8px;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:9px}
.${CLS}-chatHead{display:flex;align-items:baseline;gap:8px;justify-content:space-between}
.${CLS}-chatTitle{font-size:12.5px;font-weight:600}
.${CLS}-chatTarget{font-size:10.5px;color:var(--dsw-alias-label-secondary);max-width:190px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${CLS}-chatEmpty{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.${CLS}-bubble{padding:7px 9px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1)}
.${CLS}-bubble[data-role="user"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.${CLS}-bubbleLabel{font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);margin-bottom:2px}
.${CLS}-bubbleText{font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.${CLS}-running{font-size:11px;color:var(--dsw-alias-brand-primary)}
.${CLS}-sent{font-size:10.5px;color:var(--dsw-alias-state-success-primary)}
.${CLS}-error{font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary)}
.${CLS}-hints{display:flex;flex-direction:column;gap:2px}
.${CLS}-hintWarn{font-size:10.5px;line-height:15px;color:var(--dsw-alias-state-warn-primary)}
.${CLS}-composer{display:flex;flex-direction:column;gap:6px}
.${CLS}-input{width:100%;box-sizing:border-box;resize:vertical;min-height:52px;max-height:120px;padding:7px 9px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:17px;outline:none}
.${CLS}-input:focus{border-color:var(--dsw-alias-brand-primary)}
.${CLS}-composerRow{display:flex;align-items:center;justify-content:space-between;gap:8px}
.${CLS}-composerHint{font-size:10px;color:var(--dsw-alias-label-secondary)}
.${CLS}-send{padding:6px 12px;border:0;border-radius:8px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:12px;font-weight:600;cursor:pointer}
.${CLS}-send:disabled{opacity:.45;cursor:default}
.${CLS}-pill{pointer-events:auto;display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;cursor:grab;box-shadow:0 6px 20px rgba(0,0,0,.16);touch-action:none}
.${CLS}-pill:hover{background:var(--dsw-alias-bg-layer-1)}
.${CLS}-fab{pointer-events:auto;display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;cursor:grab;box-shadow:0 6px 20px rgba(0,0,0,.16);touch-action:none}
.${CLS}-fabDot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.${CLS}-fabDot[data-state="reading"]{background:var(--dsw-alias-brand-primary)}
.${CLS}-fabDot[data-state="armed"]{background:var(--dsw-alias-state-warn-primary)}
.${CLS}-fabDot[data-state="stopped"]{background:var(--dsw-alias-state-error-primary)}
`;
      document.head.appendChild(tag);
      return tag;
    }

    return {
      name: NS,
      inject: ['slots', 'locale', 'sessions'],
      /**
       * Register dictionaries, styles and the panel, and own all three.
       * @param ctx - the client plugin context.
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-screen-use: dictionaries');
        ctx.effect(() => {
          const tag = ensureStyles();
          return () => tag.remove();
        }, 'dsh-screen-use: stylesheet');

        const host = panelHost(ctx);
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'dsh-screen-use.panel',
              order: 100,
              label: () => t('title'),
              locale: NS,
              inject: () => host,
            },
            ScreenUsePanel,
          ),
        );
      },
    };
  },
});
