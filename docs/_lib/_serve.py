#!/usr/bin/env python3
"""Lightweight live-reload dev server for docs/.

Pure stdlib — no pip / no npm install. Watches the file tree with mtime
polling (~500ms); when anything changes, pushes a reload event to all
connected browser tabs via Server-Sent Events. HTML responses get a tiny
script injected before </body> that subscribes to the event stream.

Usage:
  python3 docs/_lib/_serve.py            # serves on 0.0.0.0:8092
  python3 docs/_lib/_serve.py --port 9000

Optional password gate (LAN): set one from the gear in the page header (stored
in .site.json next to the site, gitignored) or via $DOCSITE_PASS. With neither set the
server runs open, as it always has. Everything is edited from the gear in the
page header; see the SETTINGS block below for what the gate does and does not
protect.

Stop with Ctrl+C.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import hmac
import html as _html
import json
import os
import re
import secrets
import subprocess
import threading
from stat import S_ISREG as stat_isreg
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Empty, Queue
from urllib.parse import parse_qs, unquote, urlsplit

from _site import SITE_NAME

# docs/ root — script lives at docs/_lib/_serve.py.
V2_DIR = Path(__file__).resolve().parent.parent

# Identifies this server process. Sent to every SSE client on connect so a
# client can tell "the server restarted" (new id -> the page is stale, reload)
# from "my connection dropped" (same id -> just reconnect).
BOOT_ID = str(time.time_ns())

# ---------- site settings (dev server only) ----------
# This server binds 0.0.0.0, so anything on the LAN can reach it — including the
# /__edit WRITE endpoint. These knobs live in .site.json next to the site
# (gitignored, chmod 600) and are edited from the gear in the page header; the
# file is the single source of truth, so a restart keeps whatever you set.
#
# With NO password set the server runs open, exactly as it always has — a
# collaborator who pulls this file is never locked out of their own server.
#
# What the password is and is not: the connection is plain HTTP, so it crosses
# the LAN in the clear and so does every page. It keeps people who shouldn't be
# reading the site from wandering in; it is not protection against anyone
# who can capture traffic on the wire.
SETTINGS_FILE = V2_DIR / ".site.json"
LEGACY_AUTH_FILE = V2_DIR / ".auth"      # one-line password, the pre-panel form
AUTH_COOKIE = "docsite_auth"

DEFAULT_SETTINGS = {
    "password": "",        # "" = gate off
    "remember_ip": True,   # one login per IP per day (see IP_GRANT_SECONDS)
    "ip_grants": {},       # ip -> unix expiry; runtime state, kept beside the config
    "allow_edit": True,    # /__edit  — in-browser page editing
    "autowrap": True,      # re-bake chrome + indices when a file changes
}

# A successful login remembers the client IP for this long, so a colleague types
# the password once a day rather than after every server restart or cookie loss.
#
# The trade: this authenticates a NETWORK ADDRESS, not a person. On this LAN a
# machine is its own 10.12.x.x, so it behaves like "remember this machine" — but
# anyone arriving from behind the same NAT or VPN gateway as an authorised user
# inherits their access without knowing the password. Switch remember_ip off to
# require the password (well, the cookie) every time.
IP_GRANT_SECONDS = 24 * 3600

_settings_lock = threading.RLock()


def _read_settings() -> dict:
    out = dict(DEFAULT_SETTINGS)
    try:
        stored = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if isinstance(stored, dict):
            for k in out:
                if k in stored:
                    out[k] = stored[k]
    except (OSError, ValueError):
        # No settings file yet: adopt a legacy one-line .auth as the password so
        # a server that already had a gate keeps it across this upgrade.
        try:
            legacy = LEGACY_AUTH_FILE.read_text(encoding="utf-8").strip()
            if legacy:
                out["password"] = legacy
        except OSError:
            pass
    return out


SETTINGS = _read_settings()

# An env password overrides the file and cannot be changed from the panel — it
# belongs to whoever launched the process.
# $DOCSITE_PASS; $BLACKBOARD_PASS is still read for sites that started on the Blackboard engine.
ENV_PASSWORD = (os.environ.get("DOCSITE_PASS", "") or os.environ.get("BLACKBOARD_PASS", "")).strip()


def setting(key: str):
    with _settings_lock:
        return SETTINGS[key]


def password() -> str:
    return ENV_PASSWORD or setting("password")


def save_settings(changes: dict) -> dict:
    with _settings_lock:
        for k, v in changes.items():
            if k in SETTINGS:
                SETTINGS[k] = v
        snapshot_ = dict(SETTINGS)
    tmp = SETTINGS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(snapshot_, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    with contextlib.suppress(OSError):
        os.chmod(str(tmp), 0o600)
    os.replace(str(tmp), str(SETTINGS_FILE))
    return snapshot_


# One token for the whole process: the password is shared anyway, so per-user
# sessions would buy nothing. Rotating it signs every device out at once.
SESSION_TOKEN = secrets.token_urlsafe(32)


def rotate_session() -> str:
    """Sign every device out: new cookie token AND drop the remembered IPs.

    Dropping the IPs is the whole point — leaving them would mean "sign out
    everyone" quietly let the same machines straight back in."""
    global SESSION_TOKEN
    SESSION_TOKEN = secrets.token_urlsafe(32)
    save_settings({"ip_grants": {}})
    return SESSION_TOKEN


def _prune_grants(grants: dict) -> dict:
    now = time.time()
    return {ip: exp for ip, exp in grants.items() if exp > now}


def grant_ip(ip: str) -> None:
    if not setting("remember_ip"):
        return
    with _settings_lock:
        grants = _prune_grants(dict(SETTINGS["ip_grants"]))
        grants[ip] = time.time() + IP_GRANT_SECONDS
    save_settings({"ip_grants": grants})


def ip_granted(ip: str) -> bool:
    if not setting("remember_ip"):
        return False
    with _settings_lock:
        return float(SETTINGS["ip_grants"].get(ip, 0)) > time.time()


def grant_count() -> int:
    with _settings_lock:
        return len(_prune_grants(SETTINGS["ip_grants"]))


def _lan_ip() -> str:
    """Best-effort LAN address to hand a colleague. No packet is sent — connect()
    on a UDP socket just picks the route the kernel would use."""
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("10.255.255.255", 1))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def _page_count() -> int:
    with contextlib.suppress(OSError):
        return sum(1 for _ in (V2_DIR / "pages").rglob("*.html"))
    return 0


LOGIN_PAGE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{site}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #fafaf7; color: #1a1a1a;
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }}
  form {{ width: min(20rem, 88vw); display: flex; flex-direction: column; gap: .7rem; }}
  h1 {{ margin: 0 0 .2rem; font-size: 1.15rem; letter-spacing: -.01em; }}
  p {{ margin: 0; color: #6b6b6b; font-size: .86rem; }}
  input {{ padding: .55rem .7rem; font: inherit; color: inherit;
          background: #fff; border: 1px solid #d4d4d0; border-radius: 6px; }}
  input:focus {{ outline: 2px solid #1a1a1a; outline-offset: -1px; }}
  button {{ padding: .55rem .7rem; font: inherit; font-weight: 600; cursor: pointer;
           background: #1a1a1a; color: #fafaf7; border: 0; border-radius: 6px; }}
  .err {{ color: #a64242; font-size: .86rem; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #1a1a1c; color: #e8e8e6; }}
    p {{ color: #8a8a86; }}
    input {{ background: #232328; border-color: #3a3a3e; }}
    input:focus {{ outline-color: #cfcfcc; }}
    button {{ background: #e8e8e6; color: #1a1a1c; }}
    .err {{ color: #e8896c; }}
  }}
</style></head><body>
<form method="POST" action="/__login">
  <h1>{site}</h1>
  <p>A password is required for LAN access.</p>
  <input type="hidden" name="next" value="{next}">
  <input type="password" name="password" placeholder="Password" autofocus
         autocomplete="current-password" aria-label="Password">
  <button type="submit">Enter</button>
  {error}
</form>
</body></html>
"""

# Injected before </body> of every served HTML page.
RELOAD_SNIPPET = b"""
<script>
(function () {
  // Headless renders (agents screenshotting a page) take no part in live
  // reload: a pending connection keeps --virtual-time-budget from settling.
  if (navigator.webdriver || /HeadlessChrome/.test(navigator.userAgent)) return;
  // Live reload polls /__changes every few seconds instead of holding a
  // Server-Sent-Events stream. Chrome allows ~6 HTTP/1.1 connections per
  // host:port; six open tabs each holding an SSE stream used up every slot,
  // and the seventh request -- a page's PDF, say -- waited forever.
  var boot = null, seq = 0, fails = 0, pending = null, timer = null;
  function myPath() {
    var p = location.pathname;
    if (p.slice(-1) === '/') p += 'index.html';
    return decodeURIComponent(p).replace(/^\\//, '');
  }
  function referencedPaths() {
    // Every same-origin URL this page points at (scripts, styles, images,
    // iframes, links), plus the document behind a PDF.js viewer's ?file=.
    var set = {}, els = document.querySelectorAll('[src],[href],[data-src]');
    for (var i = 0; i < els.length; i++) {
      var v = els[i].getAttribute('src') || els[i].getAttribute('href') || els[i].getAttribute('data-src');
      if (!v || v.charAt(0) === '#') continue;
      try {
        var u = new URL(v, location.href);
        if (u.origin !== location.origin) continue;
        set[decodeURIComponent(u.pathname).replace(/^\\//, '')] = 1;
        var f = u.searchParams.get('file');
        if (f) set[decodeURIComponent(new URL(f, location.origin).pathname).replace(/^\\//, '')] = 1;
      } catch (_) {}
    }
    return set;
  }
  function concernsMe(paths) {
    // Reload only for this page's own file, a file it references, or the site
    // chrome shared by every page. The search index is rebuilt on every wrap
    // and fetched lazily, so it never warrants a reload.
    var me = myPath(), refs = referencedPaths();
    for (var i = 0; i < paths.length; i++) {
      var p = String(paths[i]).replace(/^\\//, '');
      if (p === me || refs[p]) return true;
      if (/^(assets|_lib)\\/.*\\.(css|js)$/.test(p)) return true;
    }
    return false;
  }
  function scheduleReload() {
    // A wrap touches a page's PDF, then its HTML, then the index within a
    // second or two: coalesce the burst into one reload after it goes quiet.
    // While the in-browser editor is active (nav.js sets window.__bbEditing)
    // a reload would destroy the unsaved edit, so it is swallowed.
    if (pending) clearTimeout(pending);
    pending = setTimeout(function () { pending = null; if (!window.__bbEditing) location.reload(); }, 1200);
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }
  function poll() {
    fetch('/__changes?since=' + seq, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      // 403 = the password gate ended this session (password changed, "sign
      // out everyone", server restarted with the gate on): reload onto the
      // login form rather than leave a dead page up.
      if (r.status === 403) { if (!window.__bbEditing) location.reload(); return; }
      if (!r.ok) throw new Error('status ' + r.status);
      return r.json().then(function (j) {
        fails = 0;
        if (boot === null) { boot = j.boot; seq = j.seq; }
        else if (j.boot !== boot) { if (!window.__bbEditing) { location.reload(); return; } }
        else {
          if (j.paths && j.paths.length && concernsMe(j.paths)) scheduleReload();
          seq = j.seq;
        }
        schedule(document.hidden ? 10000 : 2500);
      });
    }).catch(function () {
      fails += 1;
      schedule(fails > 5 ? 15000 : 4000);
    });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(200); });
  poll();
})();
</script>
"""

EXCLUDED_DIR_NAMES = {".git", "__pycache__", "node_modules", ".idea", ".vscode"}
# .log matters: the server's own stdout is redirected into a server.log next to the site,
# and the auto-wrap prints a dozen lines every pass. Watching it makes the server
# feed itself — wrap prints -> log grows -> "a file changed" -> reload + wrap ->
# prints again, about once a second forever. Never watch your own output.
EXCLUDED_SUFFIXES = (".swp", ".swo", ".tmp", ".pyc", ".log")

# Committed assets with a gitignored ".local" twin holding the full view —
# including gitignored sections (see _wrap_handwritten). The dev server serves
# the twin so local-only pages show up locally; the published site has no
# .local files and serves the committed public view.
LOCAL_ASSET_VARIANTS = {
    "/assets/nav.json": "/assets/nav.local.json",
    "/assets/search-index.json": "/assets/search-index.local.json",
}

# ---------- in-browser page editing ----------
# nav.js probes GET /__edit on page load and injects an Edit button into the
# header actions when it answers (dev server only — the published static site
# 404s the probe, so no button ever appears there). GET returns the page's
# authored <main> inner source plus a content hash; POST splices the edited
# source back between the same <main>…</main> markers, rejecting with 409 if
# the file changed on disk since the GET (concurrent editor / another session).
# The write then rides the normal change pipeline: auto-wrap re-bakes chrome,
# nav and search indices, and the SSE broadcast reloads every open tab.
# Same regex + innermost-match preference as _wrap_handwritten.MAIN_RE, so the
# splice point is exactly the block the wrap will re-extract.
EDIT_MAIN_RE = re.compile(
    r'<main\s+class="doc-body[^"]*"[^>]*>(.*?)</main>', re.DOTALL | re.IGNORECASE
)
EDIT_MAX_BYTES = 8_000_000  # POST payload cap


def is_excluded(p: Path) -> bool:
    if p.suffix in EXCLUDED_SUFFIXES:
        return True
    if p.name.startswith("."):
        return True
    return any(part in EXCLUDED_DIR_NAMES for part in p.parts)


def snapshot(root: Path) -> tuple:
    """Hashable signature of the tree's mtime+size state."""
    sig = []
    seen_real: set = set()  # loop guard: a symlink pointing back up the tree
    try:
        for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
            # followlinks=True: a symlinked dir under pages/ is a live mount of
            # another repo's pages (see _wrap_handwritten.mount_dirs); an edit
            # over there must reload the browser here.
            real = os.path.realpath(dirpath)
            if real in seen_real:
                dirnames[:] = []
                continue
            seen_real.add(real)
            rel_dir = Path(dirpath).relative_to(root)
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_NAMES]
            for name in filenames:
                p = Path(dirpath) / name
                if is_excluded(rel_dir / name):
                    continue
                try:
                    st = p.stat()
                    if not stat_isreg(st.st_mode):
                        continue
                    sig.append((str(rel_dir / name), st.st_mtime_ns, st.st_size))
                except (FileNotFoundError, OSError):
                    continue
    except (FileNotFoundError, OSError):
        pass
    return tuple(sig)


# ---------- adaptive polling ----------
# Every watcher pass stats the whole tree, so a fixed interval keeps spinning at
# full speed even when nobody is editing or even has a page open (1315 files at
# 0.5 s = 2630 stats a second, all year). The two tiers below make the interval
# follow what is actually happening; they only ever slow polling down, never
# below the --interval speed.
_IDLE_NO_CLIENT = 30.0  # interval while no browser holds the SSE stream
_QUIET_BACKOFF = (      # (seconds quiet, interval to use), matched longest first
    (300.0, 15.0),
    (60.0, 5.0),
    (10.0, 3.0),
)


class Watcher(threading.Thread):
    def __init__(
        self,
        root: Path,
        interval: float,
        on_change,
        *,
        label: str = "watch",
        client_count=None,
    ):
        super().__init__(daemon=True)
        self.root = root
        self.interval = interval
        self.on_change = on_change
        self.label = label
        # Callable returning the current live-reload subscriber count; None = plain fixed-interval polling.
        self.client_count = client_count
        self.last = snapshot(root)
        self._running = True
        self._last_change = time.monotonic()

    def _next_delay(self) -> float:
        """How long to wait before the next pass.

        `--interval` is the **fastest** tier; this only ever returns that value or
        more, so editing feels exactly as before and only idle spinning is saved.
        """
        # No browser connected: a change found now could not be reported to anyone.
        if self.client_count is not None and self.client_count() == 0:
            return max(self.interval, _IDLE_NO_CLIENT)
        # Someone is watching: back off by time since the last change; any change snaps back to the fastest tier.
        quiet = time.monotonic() - self._last_change
        for after, delay in _QUIET_BACKOFF:
            if quiet >= after:
                return max(self.interval, delay)
        return self.interval

    def _sleep(self, total: float) -> None:
        """Sleep in slices and wake early when a browser connects.

        Otherwise a page opened while idle could wait a full _IDLE_NO_CLIENT
        period for its first refresh. Checking the list length once a second is
        negligible next to stat-ing thousands of files.
        """
        if self.client_count is None or total <= 1.0:
            time.sleep(total)
            return
        had_clients = self.client_count() > 0
        slept = 0.0
        while slept < total and self._running:
            time.sleep(min(1.0, total - slept))
            slept += 1.0
            if not had_clients and self.client_count() > 0:
                return

    def run(self):
        while self._running:
            self._sleep(self._next_delay())
            snap = snapshot(self.root)
            if snap != self.last:
                changed = self._diff(self.last, snap)
                self.last = snap
                self._last_change = time.monotonic()
                self.on_change(changed)

    def _diff(self, old: tuple, new: tuple) -> list[str]:
        old_set = {p for p, _, _ in old}
        new_set = {p for p, _, _ in new}
        old_map = {p: (m, s) for p, m, s in old}
        new_map = {p: (m, s) for p, m, s in new}
        changed = []
        for p in new_set - old_set:
            changed.append(p)
        for p in old_set - new_set:
            changed.append(p)
        for p in new_set & old_set:
            if old_map[p] != new_map[p]:
                changed.append(p)
        return changed


# ---------- SSE coordination ----------

_subscribers = []
_subscribers_lock = threading.Lock()


# Change log for the polling clients: (seq, paths) of every broadcast, newest
# last. A client sends the last seq it saw and gets every path changed since.
_changes_lock = threading.Lock()
_change_seq = 0
_change_log: list = []          # [(seq, [paths]), ...], trimmed to the last 200
_pollers: dict = {}             # remote address -> monotonic time of its last poll
_POLLER_TTL = 30.0


def note_poller(addr: str) -> None:
    now = time.monotonic()
    with _changes_lock:
        _pollers[addr] = now
        for k in [k for k, t in _pollers.items() if now - t > _POLLER_TTL]:
            del _pollers[k]


def poller_count() -> int:
    now = time.monotonic()
    with _changes_lock:
        return sum(1 for t in _pollers.values() if now - t <= _POLLER_TTL)


def changes_since(since: int):
    """(latest seq, sorted paths changed after `since`)."""
    with _changes_lock:
        paths = set()
        if since:
            for sq, ps in _change_log:
                if sq > since:
                    paths.update(ps)
        return _change_seq, sorted(paths)


def live_client_count() -> int:
    """Browsers that would notice a reload: SSE subscribers (legacy pages) plus
    pages that polled /__changes in the last 30 s."""
    return subscriber_count() + poller_count()


def subscriber_count() -> int:
    """How many browsers hold the live-reload stream. 0 = this pass is pointless."""
    with _subscribers_lock:
        return len(_subscribers)


def broadcast_reload(changed_paths: list[str]) -> None:
    print(
        f"  ↻ reload  ({len(changed_paths)} changed: {', '.join(changed_paths[:3])}"
        f"{' ...' if len(changed_paths) > 3 else ''})"
    )
    # The payload carries the changed paths so each page can decide whether the
    # change concerns it (its own HTML, an asset it references, site chrome).
    # Before this every page reloaded on every change anywhere in the site: with
    # two agents writing pages, a page embedding a 1.5 MB PDF reloaded every few
    # seconds and never finished loading it.
    global _change_seq
    with _changes_lock:
        _change_seq += 1
        _change_log.append((_change_seq, [str(p) for p in changed_paths[:300]]))
        del _change_log[:-200]
    payload = json.dumps({"reload": True, "paths": changed_paths[:300]}, ensure_ascii=False)
    with _subscribers_lock:
        dead = []
        for q in _subscribers:
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            with contextlib.suppress(ValueError):
                _subscribers.remove(q)


def subscribe() -> Queue:
    q = Queue()
    with _subscribers_lock:
        _subscribers.append(q)
    return q


def unsubscribe(q: Queue) -> None:
    with _subscribers_lock, contextlib.suppress(ValueError):
        _subscribers.remove(q)


# ---------- HTTP handler ----------


class LiveReloadHandler(SimpleHTTPRequestHandler):
    # Suppress chatty 200-OK logging; keep 4xx/5xx + reload markers.
    def log_message(self, fmt, *args):
        if args and isinstance(args[1], str) and args[1].startswith("2"):
            return
        super().log_message(fmt, *args)

    def end_headers(self):
        # Dev-server: disable browser caching so CSS/JS edits show on next nav.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # ---- password gate (no-op when no password is set) ----

    def _has_session(self) -> bool:
        for part in (self.headers.get("Cookie") or "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == AUTH_COOKIE and hmac.compare_digest(value, SESSION_TOKEN):
                return True
        return False

    def _send_login(self, code: int = 200, error: str = "") -> None:
        nxt = self.path if self.command == "GET" else "/"
        body = LOGIN_PAGE.format(
            site=_html.escape(SITE_NAME),
            next=_html.escape(nxt, quote=True),
            error='<p class="err">%s</p>' % _html.escape(error) if error else "",
        ).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _gate(self) -> bool:
        """True to continue handling the request; False if it was answered here.

        Runs before every route, so the SSE stream, the JSON indices, the images
        and the /__edit write endpoint are all behind it — not just
        the pages."""
        if not password() or self._has_session() or ip_granted(self.client_address[0]):
            return True
        route = self.path.split("?", 1)[0]
        if route == "/__login" and self.command == "POST":
            self._handle_login()
            return False
        # Only a GET for a page gets the login form. Everything else — an image,
        # a fetch for the JSON indices, the SSE stream, the /__ endpoints, any
        # non-GET method — gets a plain 403: handing back 200 + HTML to a client
        # expecting JSON or an event stream is a lie about what happened.
        is_page = (
            self.command == "GET"
            and not route.startswith("/__")
            and (route.endswith("/") or route.endswith(".html")
                 or "." not in route.rsplit("/", 1)[-1])
        )
        if is_page:
            self._send_login()
        else:
            self.send_error(403, "Password required")
        return False

    def _handle_login(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        form = parse_qs(self.rfile.read(min(length, 4096)).decode("utf-8", "replace"))
        supplied = (form.get("password") or [""])[0]
        nxt = (form.get("next") or ["/"])[0]
        if not nxt.startswith("/") or nxt.startswith("//"):
            nxt = "/"          # never bounce to another origin
        if not hmac.compare_digest(supplied, password()):
            time.sleep(0.5)    # blunt a brute-force loop
            self._send_login(code=401, error="Wrong password")
            return
        grant_ip(self.client_address[0])
        self.send_response(303)
        self.send_header("Location", nxt)
        self.send_header(
            "Set-Cookie",
            "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800"
            % (AUTH_COOKIE, SESSION_TOKEN),
        )
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _handle_logout(self) -> None:
        ip = self.client_address[0]
        with _settings_lock:
            grants = _prune_grants(dict(SETTINGS["ip_grants"]))
        if grants.pop(ip, None) is not None:
            save_settings({"ip_grants": grants})
        self.send_response(303)
        self.send_header("Location", "/")
        self.send_header("Set-Cookie", "%s=; Path=/; Max-Age=0" % AUTH_COOKIE)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- settings panel backend ----

    def _is_local(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1", "localhost")

    def _may_configure(self) -> bool:
        """Who may see and change the settings: everyone who got past _gate().

        With a password set, _gate() has already proved this client knows it.
        With NO password set the server is wide open and so is the panel — the
        owner asked (2026-09-18) for no local/remote distinction, so the gear
        shows the same from 127.0.0.1 and from a LAN address. If someone on the
        LAN sets a password first, the owner recovers by editing .site.json on
        disk (or launching with DOCSITE_PASS) and restarting."""
        return True

    def _settings_state(self) -> dict:
        with _settings_lock:
            state = dict(SETTINGS)
        state.pop("password", None)
        state.pop("ip_grants", None)
        state["remembered_ips"] = grant_count()
        state["grant_hours"] = IP_GRANT_SECONDS // 3600
        state["has_password"] = bool(password())
        state["password_from_env"] = bool(ENV_PASSWORD)
        state["local_client"] = self._is_local()
        state["autowrap_forced_off"] = bool(os.environ.get("NO_AUTOWRAP", ""))
        state["lan_url"] = "http://%s:%s/" % (_lan_ip(), self.server.server_address[1])
        state["page_count"] = _page_count()
        state["boot_id"] = BOOT_ID
        return state

    def _handle_settings_get(self) -> None:
        if not self._may_configure():
            self.send_error(403, "Settings are not available")
            return
        self._send_json(200, self._settings_state())

    def _handle_settings_post(self) -> None:
        if not self._may_configure():
            self.send_error(403, "Settings are not available")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(min(length, 65536)) or b"{}")
        except (ValueError, OSError):
            self._send_json(400, {"error": "bad request body"})
            return

        current = password()
        if current and not hmac.compare_digest(str(payload.get("current_password", "")), current):
            time.sleep(0.5)
            self._send_json(401, {"error": "The current password is wrong"})
            return

        changes = payload.get("changes") or {}
        clean = {}
        for key in ("remember_ip", "allow_edit", "autowrap"):
            if key in changes:
                clean[key] = bool(changes[key])
        if "password" in changes:
            if ENV_PASSWORD:
                self._send_json(409, {"error": "The password is set by $DOCSITE_PASS and cannot be changed here"})
                return
            clean["password"] = str(changes["password"] or "")

        if clean.get("remember_ip") is False:
            clean["ip_grants"] = {}
        if clean:
            save_settings(clean)
        # A new password, or an explicit sign-out, invalidates every device —
        # then hand the caller a fresh cookie so the person doing it stays in.
        if "password" in clean or payload.get("sign_out_everyone"):
            token = rotate_session()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            if password():
                self.send_header(
                    "Set-Cookie",
                    "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800" % (AUTH_COOKIE, token),
                )
            else:
                self.send_header("Set-Cookie", "%s=; Path=/; Max-Age=0" % AUTH_COOKIE)
            body = json.dumps(self._settings_state()).encode("utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._send_json(200, self._settings_state())

    def do_GET(self):
        if not self._gate():
            return
        route = self.path.split("?", 1)[0]
        if route == "/__settings":
            self._handle_settings_get()
            return
        if route == "/__edit" and not setting("allow_edit"):
            self.send_error(403, "In-browser editing is switched off in settings")
            return
        if self.path.split("?", 1)[0] == "/__logout":
            self._handle_logout()
            return
        if self.path == "/__reload-stream":
            self._serve_sse()
            return
        if route == "/__changes":
            self._handle_changes()
            return
        if self.path.split("?", 1)[0] == "/__edit":
            self._handle_edit_get()
            return
        local = LOCAL_ASSET_VARIANTS.get(self.path)
        if local and os.path.exists(self.translate_path(local)):
            self.path = local
        if (self.path.endswith(".html") or self.path.endswith("/")) and self._serve_html():
            return
        super().do_GET()

    def do_HEAD(self):
        if not self._gate():
            return
        if self.path == "/__reload-stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            return
        super().do_HEAD()

    def do_POST(self):
        if not self._gate():
            return
        route = self.path.split("?", 1)[0]
        if route == "/__settings":
            self._handle_settings_post()
            return
        if route == "/__edit" and not setting("allow_edit"):
            self.send_error(403, "In-browser editing is switched off in settings")
            return
        if self.path.split("?", 1)[0] == "/__login":
            # Already authenticated — a resubmitted form, just bounce home.
            self._handle_login()
            return
        if self.path.split("?", 1)[0] == "/__edit":
            self._handle_edit_post()
            return
        self.send_error(501, "Unsupported method (POST)")

    # ---- in-browser page editing (see EDIT_MAIN_RE) ----

    def _edit_target(self, rel: str):
        """Resolve ?page=<rel> to an editable page file, or None if refused.

        Editable = an existing .html inside the site root, outside _lib/ and
        assets/, with no dot-prefixed path component (which also shields the
        .tmp write staging below from ever being a target itself).
        """
        if not rel or rel != rel.strip() or "\\" in rel or rel.startswith("/"):
            return None
        p = (V2_DIR / rel).resolve()
        try:
            parts = p.relative_to(V2_DIR).parts
        except ValueError:
            return None  # traversal outside the site root
        if not parts or parts[0] in ("_lib", "assets") or p.suffix != ".html":
            return None
        if any(part.startswith(".") for part in parts):
            return None
        return p if p.is_file() else None

    @staticmethod
    def _edit_extract(text: str):
        """(match, inner) of the authored main block; innermost match wins,
        mirroring _wrap_handwritten's extraction."""
        matches = list(EDIT_MAIN_RE.finditer(text))
        if not matches:
            return None, None
        m = matches[-1]
        return m, m.group(1)

    def _handle_edit_get(self):
        rel = (parse_qs(urlsplit(self.path).query).get("page") or [""])[0]
        target = self._edit_target(rel)
        if target is None:
            self._send_json(404, {"error": "bad page"})
            return
        try:
            text = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            self._send_json(500, {"error": "read failed"})
            return
        m, inner = self._edit_extract(text)
        if m is None:
            self._send_json(409, {"error": "page has no <main class=\"doc-body\"> block"})
            return
        digest = hashlib.sha1(inner.encode("utf-8")).hexdigest()
        self._send_json(200, {"ok": True, "source": inner, "hash": digest})

    def _handle_edit_post(self):
        rel = (parse_qs(urlsplit(self.path).query).get("page") or [""])[0]
        target = self._edit_target(rel)
        if target is None:
            self._send_json(404, {"error": "bad page"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > EDIT_MAX_BYTES:
            self._send_json(413, {"error": "payload too large or empty"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"error": "bad json"})
            return
        source = payload.get("source") if isinstance(payload, dict) else None
        if not isinstance(source, str):
            self._send_json(400, {"error": "expected {source, base_hash}"})
            return
        try:
            text = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            self._send_json(500, {"error": "read failed"})
            return
        m, inner = self._edit_extract(text)
        if m is None:
            self._send_json(409, {"error": "page has no <main class=\"doc-body\"> block"})
            return
        digest = hashlib.sha1(inner.encode("utf-8")).hexdigest()
        if payload.get("base_hash") != digest:
            self._send_json(409, {"error": "page changed on disk since you started editing"})
            return
        new_text = text[: m.start(1)] + "\n" + source.strip("\n") + "\n" + text[m.end(1) :]
        try:
            tmp = target.with_name("." + target.name + ".tmp")  # dot + .tmp → watcher-excluded
            tmp.write_text(new_text, encoding="utf-8")
            os.replace(tmp, target)
        except OSError:
            self._send_json(500, {"error": "write failed"})
            return
        print(f"  ✎ edit saved: {rel}")
        self._send_json(200, {"ok": True})

    def _send_json(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            with contextlib.suppress(BrokenPipeError, ConnectionResetError, OSError):
                self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        # Custom 404 page (404.html at the site root) with the reload snippet, so a
        # newly created page refreshes any tab that was sitting on its 404.
        page = V2_DIR / "404.html"
        if code == 404 and page.is_file():
            try:
                content = page.read_bytes()
            except OSError:
                super().send_error(code, message, explain)
                return
            idx = content.lower().rfind(b"</body>")
            if idx >= 0:
                content = content[:idx] + RELOAD_SNIPPET + content[idx:]
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            if self.command != "HEAD":
                with contextlib.suppress(BrokenPipeError, ConnectionResetError, OSError):
                    self.wfile.write(content)
            return
        super().send_error(code, message, explain)

    def _handle_changes(self):
        """Live-reload poll: ?since=<seq> -> {boot, seq, paths changed after seq}."""
        qs = parse_qs(urlsplit(self.path).query)
        try:
            since = int(qs.get("since", ["0"])[0])
        except ValueError:
            since = 0
        note_poller(self.client_address[0])
        seq, paths = changes_since(since)
        self._send_json(200, {"boot": BOOT_ID, "seq": seq, "paths": paths})

    def _serve_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = subscribe()
        try:
            self.wfile.write(f"event: hello\ndata: {BOOT_ID}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=2)
                    self.wfile.write(f"data: {msg}\n\n".encode())
                    self.wfile.flush()
                except Empty:
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            unsubscribe(q)

    @staticmethod
    def _mounted_render(path: str):
        """A page inside a live mount (a symlinked dir under pages/, see
        _wrap_handwritten.mount_dirs) is another repo's file, carrying that repo's
        chrome or none. Bake this site's chrome around its content in memory, per
        request, so the file itself is never written. None = not a mounted page."""
        import _wrap_handwritten as _wrap

        p = Path(path)
        try:
            if not _wrap.is_mounted(p):
                return None
            return _wrap.render_page(p)[0].encode("utf-8")
        except Exception as e:
            print(f"  (mount render failed for {path}: {type(e).__name__}: {e})")
            return None

    def _serve_html(self) -> bool:
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            for index in ("index.html", "index.htm"):
                cand = os.path.join(path, index)
                if os.path.exists(cand):
                    path = cand
                    break
            else:
                return False  # let parent handle dir listing
        if not os.path.exists(path) or not os.path.isfile(path):
            return False
        content = self._mounted_render(path)
        if content is None:
            try:
                with open(path, "rb") as f:
                    content = f.read()
            except OSError:
                return False
        idx = content.lower().rfind(b"</body>")
        if idx >= 0:
            content = content[:idx] + RELOAD_SNIPPET + content[idx:]
        else:
            content = content + RELOAD_SNIPPET
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)
        return True


# ---------- driver ----------


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--port", type=int, default=8092, help="HTTP port (default: 8092)")
    p.add_argument("--host", default="0.0.0.0", help="bind address (default: 0.0.0.0)")
    p.add_argument(
        "--interval", type=float, default=0.5, help="poll interval in seconds (default: 0.5)"
    )
    args = p.parse_args()

    os.chdir(V2_DIR)
    # NO_AUTOWRAP forces it off for the whole process; otherwise the settings
    # panel owns the switch, so it is read fresh on every change event.
    autowrap_forced_off = os.environ.get("NO_AUTOWRAP", "") != ""

    def autowrap_on() -> bool:
        return not autowrap_forced_off and setting("autowrap")

    autowrap = autowrap_on()
    print("docs/ live-reload server")
    print(f"  root      : {V2_DIR}")
    print(f"  url       : http://{args.host}:{args.port}/")
    print(f"  interval  : {args.interval}s")
    print(f"  auto-wrap : {'on' if autowrap else 'off (NO_AUTOWRAP set)' if autowrap_forced_off else 'off (settings)'}")

    # Re-bake the chrome on every change before reloading the browser — so
    # dropping a folder of pages "just works" with no manual wrap step.
    if not autowrap_forced_off:
        import _wrap_handwritten as _wrap

    def on_change(changed):
        if autowrap_on():
            try:
                n = _wrap.main(quiet=True)
                if n:
                    print(f"  ⤷ wrapped {n} page(s)")
            except Exception as e:
                print(f"  (auto-wrap error: {type(e).__name__}: {e})")
            # Absorb the wrap's own writes so they aren't seen as a new change.
            html_watcher.last = snapshot(V2_DIR)
        broadcast_reload(changed)

    html_watcher = Watcher(
        V2_DIR, args.interval, on_change, label="html", client_count=live_client_count
    )

    # Bind + serve FIRST so the port is reachable instantly. The initial chrome
    # bake can take a few seconds on a large site (Python 3.8, hundreds of pages
    # + the search index), so it runs in a background thread instead of blocking
    # the bind — otherwise the port refuses connections until the bake finishes.
    # Pages are already baked on disk, so requests served before it completes are
    # correct; when the bake finishes it nudges any open browser to reload.
    server = ThreadingHTTPServer((args.host, args.port), LiveReloadHandler)

    def _initial_bake():
        if not autowrap_on():
            return
        try:
            _wrap.main(quiet=True)
        except Exception as e:
            print(f"  (initial wrap skipped: {type(e).__name__}: {e})")
            return
        # Absorb the bake's own writes, then reload any browser onto the fresh build.
        html_watcher.last = snapshot(V2_DIR)
        broadcast_reload(["(initial bake)"])

    threading.Thread(target=_initial_bake, daemon=True).start()
    html_watcher.start()

    if password():
        src = "$DOCSITE_PASS" if ENV_PASSWORD else SETTINGS_FILE
        print("  Password gate: ON (%s) — plain HTTP, so treat it as a door, not a safe." % src)
    else:
        print("  Password gate: off — anyone on the LAN can read AND edit. Turn it on from the ⚙ in the header.")
    print("  Ctrl+C to stop.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  bye.")
        server.server_close()


if __name__ == "__main__":
    main()
