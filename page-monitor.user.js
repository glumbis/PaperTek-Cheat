// ==UserScript==
// @name         Page Monitor
// @version      2.0
// @description  Makes the page think it is fullscreen, and logs what it requests, reads and listens for
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";
  if (window.pageLog) return;

  // ---------- Settings ----------
  const CONFIG = {
    // false (recommended): the game's button really goes fullscreen, so the game gets real
    // (isTrusted) events. Press Esc afterwards and the game still thinks it's fullscreen.
    // true: the button only pretends. Its events are fake, and games that check isTrusted notice.
    fakeFullscreenButton: false,
    // Hide switching tabs or clicking other windows (blur, visibilitychange, hasFocus).
    hideFocusLoss: true,
    // Pretend the window is exactly screen-sized. Only turn this on if the game still says
    // you're not fullscreen. In a normal window the game may then draw too big and get cut off.
    fakeSizes: false,
  };

  // =====================================================================
  //  Fullscreen spoof (runs first, so the monitor below logs the fake values)
  // =====================================================================

  function findDescriptor(obj, prop) {
    for (let o = obj; o; o = Object.getPrototypeOf(o)) {
      const desc = Object.getOwnPropertyDescriptor(o, prop);
      if (desc) return { owner: o, desc };
    }
    return null;
  }

  // Native fullscreen getters, saved before anything is replaced
  const realFullscreenGetters = ["fullscreenElement", "webkitFullscreenElement", "mozFullScreenElement", "msFullscreenElement"]
    .map((p) => findDescriptor(document, p))
    .filter((f) => f && f.desc.get)
    .map((f) => f.desc.get);

  function realFullscreenElement() {
    for (const get of realFullscreenGetters) {
      const el = get.call(document);
      if (el) return el;
    }
    return null;
  }

  // The element the page should think is fullscreen. "root" means <html>, looked up each time.
  // A real fullscreen element, if there is one, always wins.
  let fakeElement = "root";
  function currentFullscreenElement() {
    return realFullscreenElement() || (fakeElement === "root" ? document.documentElement : fakeElement);
  }
  const isFullscreen = () => !!currentFullscreenElement();

  // Remembers the last element that was really fullscreen, so the page keeps seeing it after Esc.
  // Capture listener on document, added first, so it runs before any of the page's listeners.
  for (const type of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(type, () => {
      const el = realFullscreenElement();
      if (el) fakeElement = el;
    }, true);
  }

  // Replaces a getter so `target` gets getValue(), while every other object keeps its real value.
  // The getter is wrapped in a Proxy so it still looks like native code.
  function fakeProperty(target, prop, getValue) {
    const found = target && findDescriptor(target, prop);
    if (!found || !found.desc.get || !found.desc.configurable) return; // missing in this browser: skip
    const { owner, desc } = found;
    Object.defineProperty(owner, prop, {
      ...desc,
      get: new Proxy(desc.get, {
        apply: (fn, self, args) => (self === target ? getValue() : Reflect.apply(fn, self, args)),
      }),
    });
  }

  // Replaces a method with new behavior, keeping its native look.
  function fakeMethod(target, prop, impl) {
    if (!target || typeof target[prop] !== "function") return;
    target[prop] = new Proxy(target[prop], { apply: (fn, self, args) => impl(fn, self, args) });
  }

  // ---------- Fullscreen properties ----------
  for (const p of ["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement",
    "mozFullScreenElement", "msFullscreenElement"]) fakeProperty(document, p, currentFullscreenElement);
  for (const p of ["fullscreen", "webkitIsFullScreen", "mozFullScreen"]) fakeProperty(document, p, isFullscreen);
  for (const p of ["fullscreenEnabled", "webkitFullscreenEnabled", "mozFullScreenEnabled", "msFullscreenEnabled"])
    fakeProperty(document, p, () => true);
  fakeProperty(window, "fullScreen", isFullscreen); // Firefox only

  // ---------- fullscreenchange events ----------
  const nativeDispatch = EventTarget.prototype.dispatchEvent;
  const hasWebkitEvents = "onwebkitfullscreenchange" in document;
  function fireFullscreenChange(el) {
    const target = el && el.isConnected ? el : document;
    const fire = (type) => nativeDispatch.call(target, new Event(type, { bubbles: true, composed: true }));
    fire("fullscreenchange");
    if (hasWebkitEvents) fire("webkitfullscreenchange");
  }

  // ---------- The game's fullscreen button ----------
  if (CONFIG.fakeFullscreenButton) {
    for (const name of ["requestFullscreen", "webkitRequestFullscreen", "webkitRequestFullScreen",
      "mozRequestFullScreen", "msRequestFullscreen"]) {
      fakeMethod(Element.prototype, name, (fn, el) => {
        const done = new Promise((resolve) => setTimeout(() => {
          fakeElement = el;
          fireFullscreenChange(el);
          resolve();
        }, 0));
        return name === "requestFullscreen" ? done : undefined; // prefixed versions return nothing
      });
    }
    for (const name of ["exitFullscreen", "webkitExitFullscreen", "webkitCancelFullScreen",
      "mozCancelFullScreen", "msExitFullscreen"]) {
      fakeMethod(Document.prototype, name, (fn, doc, args) => {
        if (realFullscreenElement()) return Reflect.apply(fn, doc, args); // in real fullscreen: really leave
        const previous = currentFullscreenElement();
        const done = new Promise((resolve) => setTimeout(() => {
          fakeElement = null;
          if (previous) fireFullscreenChange(previous);
          resolve();
        }, 0));
        return name === "exitFullscreen" ? done : undefined;
      });
    }
  }

  // ---------- :fullscreen in selectors ----------
  // Selectors like ":fullscreen" are rewritten to an attribute that sits on the "fullscreen" element.
  const ATTR = "data-fullscreen";
  const FS_PSEUDO = /:(?:-webkit-|-moz-|-ms-)?full-?screen(?![\w-])/gi;
  const nativeSetAttr = Element.prototype.setAttribute;
  const nativeRemoveAttr = Element.prototype.removeAttribute;
  let marked = null;
  function markFullscreenElement() {
    const el = currentFullscreenElement();
    if (el === marked) return;
    if (marked) nativeRemoveAttr.call(marked, ATTR);
    if (el) nativeSetAttr.call(el, ATTR, "");
    marked = el;
  }
  for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
    for (const name of ["matches", "webkitMatchesSelector", "closest", "querySelector", "querySelectorAll"]) {
      if (!Object.prototype.hasOwnProperty.call(proto, name)) continue;
      fakeMethod(proto, name, (fn, self, args) => {
        if (typeof args[0] === "string") {
          const rewritten = args[0].replace(FS_PSEUDO, "[" + ATTR + "]");
          if (rewritten !== args[0]) {
            markFullscreenElement();
            args = [rewritten, ...args.slice(1)];
          }
        }
        return Reflect.apply(fn, self, args);
      });
    }
  }

  // ---------- Media queries ----------
  fakeMethod(window, "matchMedia", (fn, self, args) => {
    const mql = Reflect.apply(fn, self, args);
    const q = String(args[0]);
    let fake = null;
    if (/display-mode:\s*fullscreen/i.test(q)) fake = isFullscreen;
    else if (/display-mode:\s*browser/i.test(q)) fake = () => !isFullscreen();
    if (fake) Object.defineProperty(mql, "matches", { configurable: true, get: fake });
    return mql;
  });

  // ---------- Focus and tab visibility ----------
  if (CONFIG.hideFocusLoss) {
    fakeProperty(document, "hidden", () => false);
    fakeProperty(document, "webkitHidden", () => false);
    fakeProperty(document, "visibilityState", () => "visible");
    fakeProperty(document, "webkitVisibilityState", () => "visible");
    fakeMethod(Document.prototype, "hasFocus", () => true);
    // Stops window/tab focus-loss events before any page listener sees them.
    // Only events aimed at the window or document are stopped, so text fields still get their blur.
    for (const type of ["blur", "visibilitychange", "webkitvisibilitychange"]) {
      window.addEventListener(type, (e) => {
        if (e.target === window || e.target === document) e.stopImmediatePropagation();
      }, true);
    }
  }

  // ---------- Window size (off by default) ----------
  if (CONFIG.fakeSizes) {
    const screenW = () => screen.width; // the real screen, whatever monitor you have
    const screenH = () => screen.height;
    const zero = () => 0;
    fakeProperty(window, "innerWidth", screenW);
    fakeProperty(window, "innerHeight", screenH);
    fakeProperty(window, "outerWidth", screenW);
    fakeProperty(window, "outerHeight", screenH);
    for (const p of ["screenX", "screenY", "screenLeft", "screenTop"]) fakeProperty(window, p, zero);
    fakeProperty(window.visualViewport, "width", screenW);
    fakeProperty(window.visualViewport, "height", screenH);
    fakeProperty(window.visualViewport, "offsetLeft", zero);
    fakeProperty(window.visualViewport, "offsetTop", zero);
  }

  // From the old script (not needed for fullscreen). Chromium only; skipped elsewhere.
  fakeProperty(navigator, "deviceMemory", () => 8);

  // =====================================================================
  //  Page monitor
  // =====================================================================

  // ---------- Log storage ----------
  const entries = [];
  const counts = new Map(); // "category name" -> total occurrences
  const lastLogged = new Map(); // "category name" -> time of last stored entry
  const THROTTLE_MS = 1000; // high-frequency items are stored at most once per second
  let busy = false; // stops the monitor from logging its own activity

  const api = {
    live: false, // set pageLog.live = true to print entries as they happen
    entries,
    config: CONFIG,
    fullscreen: () => currentFullscreenElement(), // what the page currently sees as fullscreen
    show(category) {
      const rows = [...entries]
        .sort((a, b) => a.ms - b.ms)
        .filter((e) => !category || e.category === category);
      console.table(rows);
    },
    totals() {
      const rows = [...counts]
        .map(([item, times]) => ({ item, times }))
        .sort((a, b) => b.times - a.times);
      console.table(rows);
    },
    download() {
      const sorted = [...entries].sort((a, b) => a.ms - b.ms);
      const blob = new Blob([JSON.stringify(sorted, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "page-log.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    clear() {
      entries.length = 0;
      counts.clear();
      lastLogged.clear();
    },
  };

  // ---------- Recording ----------
  const urlRe = /((?:https?|file|blob|chrome-extension|moz-extension):[^\s()]+?):\d+:\d+/;
  const selfURL = ((new Error().stack || "").match(urlRe) || [])[1];

  // Finds the first script in the call stack that is not this monitor.
  function caller() {
    for (const line of (new Error().stack || "").split("\n")) {
      const m = line.match(urlRe);
      if (m && m[1] !== selfURL) return m[0];
    }
    return "";
  }

  function describeTarget(t) {
    if (t === window) return "window";
    if (t === document) return "document";
    if (t instanceof Element) return "<" + t.tagName.toLowerCase() + (t.id ? "#" + t.id : "") + ">";
    return (t && t.constructor && t.constructor.name) || String(t);
  }

  function summarize(v) {
    try {
      if (typeof v === "function") v = v(); // details are computed lazily, inside the busy guard
      if (v == null || typeof v !== "object") return String(v).slice(0, 300);
      if (v instanceof Element) return describeTarget(v);
      return JSON.stringify(v).slice(0, 300);
    } catch (e) {
      return "[unreadable]";
    }
  }

  function record(category, name, detail, opts = {}) {
    if (busy) return;
    busy = true;
    try {
      const key = category + " " + name;
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      const at = opts.at ?? performance.now(); // ms since the page started loading
      if (opts.throttle && at - (lastLogged.get(key) ?? -Infinity) < THROTTLE_MS) return;
      lastLogged.set(key, at);
      const entry = {
        ms: Math.round(at),
        clock: new Date(performance.timeOrigin + at).toLocaleTimeString(),
        category,
        name,
        detail: summarize(detail),
        nth: n,
        source: opts.source ?? caller(),
      };
      entries.push(entry);
      if (api.live) console.log(`[${entry.ms} ms] ${category}: ${name}`, entry.detail);
    } finally {
      busy = false;
    }
  }

  // ---------- Wrapping helpers ----------
  // Replaces a property getter (and setter, if any) with one that logs each access.
  function watchProperty(target, prop, label) {
    const found = target && findDescriptor(target, prop);
    if (!found) return;
    const { owner, desc } = found;
    if (!desc.get || !desc.configurable) return;
    const name = label + "." + prop;
    const replacement = {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        const value = desc.get.call(this);
        record("reads", name, () => value, { throttle: true });
        return value;
      },
    };
    if (desc.set) {
      replacement.set = function (value) {
        record("writes", name, () => value, { throttle: true });
        return desc.set.call(this, value);
      };
    }
    Object.defineProperty(owner, prop, replacement);
  }

  // Replaces a method with a proxy that logs each call.
  function watchMethod(target, prop, category, label, describe) {
    const original = target && target[prop];
    if (typeof original !== "function") return;
    target[prop] = new Proxy(original, {
      apply(fn, thisArg, args) {
        record(category, label + "." + prop, () => describe(args, thisArg));
        return Reflect.apply(fn, thisArg, args);
      },
    });
  }

  // ---------- Requests made by scripts ----------
  const urlOf = (a) => String(a[0] && a[0].url ? a[0].url : a[0]);
  watchMethod(window, "fetch", "requests", "window", urlOf);
  watchMethod(XMLHttpRequest.prototype, "open", "requests", "XMLHttpRequest", (a) => a[0] + " " + a[1]);
  watchMethod(Navigator.prototype, "sendBeacon", "requests", "navigator", urlOf);
  for (const C of ["WebSocket", "EventSource", "Worker"]) {
    if (typeof window[C] !== "function") continue;
    window[C] = new Proxy(window[C], {
      construct(T, args, newTarget) {
        record("requests", C, () => String(args[0]));
        return Reflect.construct(T, args, newTarget);
      },
    });
  }

  // ---------- Everything the browser loaded (HTML, scripts, CSS, images, fonts, ...) ----------
  function observe(type) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          record("loaded", e.initiatorType || type, `${e.name} (${Math.round(e.duration)} ms)`,
            { at: e.startTime, source: "" });
        }
      }).observe({ type, buffered: true }); // buffered: also reports what loaded before this ran
    } catch (e) {}
  }
  observe("navigation");
  observe("resource");

  // ---------- Information the page reads about itself and the device ----------
  ["innerWidth", "innerHeight", "outerWidth", "outerHeight", "devicePixelRatio",
    "scrollX", "scrollY", "screenX", "screenY", "fullScreen"].forEach((p) => watchProperty(window, p, "window"));
  ["width", "height", "availWidth", "availHeight", "colorDepth", "orientation"]
    .forEach((p) => watchProperty(screen, p, "screen"));
  ["userAgent", "language", "languages", "platform", "hardwareConcurrency", "deviceMemory",
    "maxTouchPoints", "webdriver", "cookieEnabled"].forEach((p) => watchProperty(navigator, p, "navigator"));
  ["fullscreenElement", "webkitFullscreenElement", "fullscreen", "webkitIsFullScreen", "fullscreenEnabled",
    "visibilityState", "hidden", "cookie", "referrer"].forEach((p) => watchProperty(document, p, "document"));

  // ---------- Notable API calls ----------
  watchMethod(window, "matchMedia", "calls", "window", (a) => a[0]);
  watchMethod(Element.prototype, "requestFullscreen", "calls", "element", (a, el) => describeTarget(el));
  watchMethod(Element.prototype, "webkitRequestFullscreen", "calls", "element", (a, el) => describeTarget(el));
  watchMethod(Document.prototype, "exitFullscreen", "calls", "document", () => "");
  watchMethod(Document.prototype, "hasFocus", "calls", "document", () => "");
  watchMethod(HTMLCanvasElement.prototype, "toDataURL", "calls", "canvas", () => "canvas read as image");
  watchMethod(CanvasRenderingContext2D.prototype, "getImageData", "calls", "canvas", (a) => a.join(", "));
  watchMethod(navigator.geolocation, "getCurrentPosition", "calls", "geolocation", () => "");
  watchMethod(navigator.geolocation, "watchPosition", "calls", "geolocation", () => "");
  watchMethod(navigator.mediaDevices, "getUserMedia", "calls", "mediaDevices", (a) => a[0]);
  watchMethod(navigator.mediaDevices, "enumerateDevices", "calls", "mediaDevices", () => "");
  watchMethod(Navigator.prototype, "getBattery", "calls", "navigator", () => "");

  // ---------- Events: what the page listens for, and what it actually receives ----------
  const NOISY = new Set(["mousemove", "pointermove", "pointerrawupdate", "mouseover", "mouseout",
    "pointerover", "pointerout", "scroll", "wheel", "touchmove", "drag", "dragover"]);
  const wrappers = new WeakMap(); // original listener -> logging wrapper
  const delivered = new WeakSet(); // logs each event once, even with several listeners

  function eventDetail(e) {
    const d = { target: describeTarget(e.target) };
    if ("clientX" in e) { d.x = e.clientX; d.y = e.clientY; }
    if ("key" in e) d.key = e.key;
    return d;
  }

  function wrapListener(listener) {
    const usable = typeof listener === "function" ||
      (listener && typeof listener.handleEvent === "function");
    if (!usable) return listener;
    let w = wrappers.get(listener);
    if (!w) {
      w = function (event) {
        if (!delivered.has(event)) {
          delivered.add(event);
          record("sees", event.type, () => eventDetail(event), { throttle: NOISY.has(event.type) });
        }
        return typeof listener === "function"
          ? listener.call(this, event)
          : listener.handleEvent(event);
      };
      wrappers.set(listener, w);
    }
    return w;
  }

  const ET = EventTarget.prototype;
  const nativeAdd = ET.addEventListener;
  const nativeRemove = ET.removeEventListener;
  ET.addEventListener = function (type, listener, options) {
    record("listens", type, () => describeTarget(this));
    return nativeAdd.call(this, type, wrapListener(listener), options);
  };
  ET.removeEventListener = function (type, listener, options) {
    return nativeRemove.call(this, type, (listener && wrappers.get(listener)) || listener, options);
  };

  // ---------- Page milestones ----------
  nativeAdd.call(document, "DOMContentLoaded", () => record("milestone", "DOMContentLoaded", "", { source: "" }));
  nativeAdd.call(window, "load", () => record("milestone", "load", "", { source: "" }));

  window.pageLog = api;
  console.log("Page Monitor active (fullscreen spoof on). Use pageLog.show(), pageLog.totals(), " +
    "pageLog.download(), pageLog.fullscreen().");
})();
