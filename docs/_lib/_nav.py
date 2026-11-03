#!/usr/bin/env python3
"""Site navigation for docs/ — plug-and-play, filesystem-driven.

Each top tab is discovered by scanning `docs/pages/<dir>/`. Drop a new
directory in → new tab appears. Delete it → tab disappears. Code in
this file has zero awareness of any specific tab's existence (no
"Research" / "AAS" / etc. strings hardcoded).

Per-tab overrides live in `docs/pages/<dir>/_tab.json`. Fields (all
optional):

  label             str    — tab text (default: title-cased dir name)
  key               str    — CSS accent class (default: dir name)
  landing           str    — landing path *relative to the tab dir*
                              (default: "index.html"; falls back to
                               the first index.html found anywhere
                               under the dir)
  order_priority    int    — smaller = leftward in the tab strip
                              (default: 100; ties broken by dir name)
  pinned            bool   — always visible in the tab strip; unpinned
                              tabs render inside a horizontally
                              scrollable middle strip (default: false)
  group             str    — dropdown group label. Tabs sharing one
                              `group` collapse into a single dropdown
                              tab in the strip, sitting where the first
                              member would have sat; the members are
                              listed in its menu (default: none —
                              the tab renders standalone)
  host              str    — directory name of another tab that owns this
                              dir's pages. A dir with `host` gets NO top
                              tab of its own; its pages count as pages of
                              the host tab (breadcrumb chrome, active tab)
                              and appear wherever the host's `sections`
                              point at them — a `dir` may start with
                              "pages/" to reach outside the host's folder.
                              Lets a folder move in the nav without moving
                              on disk, so published URLs and every inbound
                              link keep working (default: none)
  external_layout   bool   — page has its own chrome; wrapper skips it
                              (default: false)
  sections          list   — curated sidebar groups. Each entry:
      label    : section label
      dir      : path relative to the tab dir (or to docs/ root if
                  it already starts with "pages/")
      key      : CSS accent class
      order    : optional curated stem order inside that section
      only_listed : bool — list ONLY the stems named in `order` (plus a
                  section index.html). Lets several sections split one
                  dir between them (e.g. anatomy → Zero-shot / Trained)
      no_auto_index : bool — with only_listed, do NOT auto-include the
                  dir's index.html (for labeled sections splitting the tab
                  root, whose index already sits in the main section)
      nav_key  : optional collapse-state key override — REQUIRED when two
                  sections share a dir, else they share open/closed state
      groups   : optional list of VIRTUAL collapsible sub-groups appended
                  after the section's own pages. Each entry: label / dir /
                  order / only_listed / nav_key (same semantics as a
                  section). Lets pages from another dir nest under this
                  section without moving files (e.g. the Zero-shot anatomy
                  series under Knowledge, below the taxonomy page)
      files_only / depth_limit : same semantics as before

  Without `sections`, the sidebar auto-discovers from the tab dir —
  each subdir becomes a section, alphabetical.
"""

from __future__ import annotations

import html
import json
import re
import subprocess
from html.parser import HTMLParser
from pathlib import Path

from _site import SITE_NAME

# Resolves to the docs/ root (script lives at docs/_lib/_nav.py).
V2 = Path(__file__).resolve().parent.parent
PAGES = V2 / "pages"


# ---------- gitignore-driven visibility ----------

# Paths under pages/ that git ignores (docs-relative posix; dirs + .html files).
# Computed once per build; invalidate_discovery_cache() drops it so a long-lived
# dev server picks up new dirs / .gitignore edits on the next wrap pass.
_IGNORED_CACHE: frozenset[str] | None = None


def _ignored_under_pages() -> frozenset[str]:
    global _IGNORED_CACHE
    if _IGNORED_CACHE is not None:
        return _IGNORED_CACHE
    candidates = [
        p.relative_to(V2).as_posix() for p in PAGES.rglob("*") if p.is_dir() or p.suffix == ".html"
    ]
    ignored: frozenset[str] = frozenset()
    if candidates:
        try:
            proc = subprocess.run(
                ["git", "check-ignore", "--stdin", "-z"],
                cwd=V2,
                input="\0".join(candidates),
                capture_output=True,
                text=True,
                timeout=30,
            )
            # 0 = some ignored, 1 = none ignored; anything else (no git /
            # not a repo) falls through to "nothing is private".
            if proc.returncode in (0, 1):
                ignored = frozenset(p for p in proc.stdout.split("\0") if p)
        except (OSError, subprocess.SubprocessError):
            pass
    _IGNORED_CACHE = ignored
    return ignored


def is_private_rel(rel: str) -> bool:
    """True when the docs-relative path is gitignored.

    Gitignore is the single visibility switch: an ignored dir/page still renders
    on the local dev site but is dropped from every committed artifact (nav.json,
    search-index.json), so it never reaches the published site. On a checkout
    without git nothing reads as private — such machines also lack the ignored
    dirs, so nothing can leak.
    """
    rel = rel.rstrip("/")
    roots = _ignored_under_pages() | _mount_rels()
    if rel in roots:
        return True
    # A private dir makes everything under it private. Needed for live mounts
    # (see _wrap_handwritten.mount_dirs): rglob does not descend into a symlinked
    # dir, so its pages are never in the ignored set by name, only by prefix.
    return any(rel.startswith(root + "/") for root in roots)


def _mount_rels() -> frozenset[str]:
    """Symlinked dirs under pages/ (docs-relative posix): live mounts of another
    repo's pages, always private — the link exists only on this machine."""
    global _MOUNT_CACHE
    if _MOUNT_CACHE is not None:
        return _MOUNT_CACHE
    found: set[str] = set()
    if PAGES.exists():
        import os

        for dirpath, dirnames, _files in os.walk(PAGES):
            for d in dirnames:
                p = Path(dirpath) / d
                if p.is_symlink() and p.is_dir():
                    found.add(p.relative_to(V2).as_posix())
    _MOUNT_CACHE = frozenset(found)
    return _MOUNT_CACHE


_MOUNT_CACHE: frozenset[str] | None = None


# ---------- per-tab config loading ----------


def _default_label(dir_name: str) -> str:
    return dir_name.replace("-", " ").replace("_", " ").title()


def _load_tab_cfg(tab_dir: Path) -> dict:
    cfg_file = tab_dir / "_tab.json"
    if not cfg_file.exists():
        return {}
    try:
        return json.loads(cfg_file.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"warn: bad _tab.json at {cfg_file}: {e}")
        return {}


def _find_default_landing(tab_dir: Path) -> str | None:
    """Pick a landing path (relative to tab_dir). Order of preference:
    tab_dir/index.html → first top-level .html (open to top-level content) →
    first index.html anywhere underneath → first .html found anywhere. The last
    fallbacks mean a folder with NO index.html still gets a tab."""
    direct = tab_dir / "index.html"
    if direct.exists():
        return "index.html"
    top = sorted(tab_dir.glob("*.html"), key=lambda p: p.name.lower())
    if top:
        return top[0].name
    for f in sorted(tab_dir.rglob("index.html")):
        return f.relative_to(tab_dir).as_posix()
    for f in sorted(tab_dir.rglob("*.html"), key=lambda p: p.as_posix().lower()):
        return f.relative_to(tab_dir).as_posix()
    return None


def get_tabs(include_private: bool = True) -> list[dict]:
    """Scan docs/pages/<dir>/ and return one tab dict per discovered dir.

    include_private=False drops tabs whose dir is gitignored (see is_private_rel)
    — used when building the committed nav.json so local-only sections never
    leak into the published site.

    Returns same shape as the old hardcoded TABS list, with one extra
    `_dir` field so consumers can find a tab by directory name.
    """
    if not PAGES.exists():
        return []

    discovered: list[tuple[tuple, dict]] = []
    for d in sorted(PAGES.iterdir()):
        if not d.is_dir() or d.name.startswith("_") or d.name.startswith("."):
            continue
        if not include_private and is_private_rel(f"pages/{d.name}"):
            continue
        cfg = _load_tab_cfg(d)
        if cfg.get("host"):
            # Hosted dir — another tab's `sections` surface its pages; it gets
            # no tab strip entry of its own. See resolve_tab_dir().
            continue
        landing_rel = cfg.get("landing") or _find_default_landing(d)
        if landing_rel is None:
            # Nothing serveable in this dir — skip silently (matches
            # the user-facing contract: "tab disappears if absent").
            continue
        landing = f"pages/{d.name}/{landing_rel}"

        label = cfg.get("label") or _default_label(d.name)
        key = cfg.get("key") or d.name
        external = bool(cfg.get("external_layout"))
        priority = int(cfg.get("order_priority", 100))
        pinned = bool(cfg.get("pinned"))
        group = str(cfg.get("group") or "")

        sections_cfg = cfg.get("sections")
        # Auto mode (no explicit `sections`): the sidebar is built by recursively
        # mirroring the tab folder — loose .html as pages, subfolders as dividers,
        # index.html as a folder's default page (see render_sidebar / _scan_root).
        # No per-section precomputation needed. Explicit `sections` keep the old
        # curated behaviour.
        auto_nav = sections_cfg is None

        sections: list[dict] = []
        for sec in sections_cfg or []:
            sec = dict(sec)
            sec_dir = sec.get("dir", "")
            if not sec_dir.startswith("pages/"):
                sec["dir"] = f"pages/{d.name}/{sec_dir}".rstrip("/")
            if sec.get("groups"):
                # Recursive: a group may itself carry `groups`, and every level
                # writes its dir relative to the tab dir.
                def _abs_groups(groups: list, tab: str = d.name) -> list:
                    out = []
                    for grp in groups:
                        grp = dict(grp)
                        g_dir = grp.get("dir", "")
                        if not g_dir.startswith("pages/"):
                            grp["dir"] = f"pages/{tab}/{g_dir}".rstrip("/")
                        if grp.get("groups"):
                            grp["groups"] = _abs_groups(grp["groups"], tab)
                        out.append(grp)
                    return out

                sec["groups"] = _abs_groups(sec["groups"])
            sections.append(sec)

        discovered.append(
            (
                (priority, d.name),
                {
                    "tab": label,
                    "key": key,
                    "landing": landing,
                    "sections": sections,
                    "auto_nav": auto_nav,
                    "external_layout": external,
                    "pinned": pinned,
                    "group": group,
                    "_dir": d.name,
                },
            )
        )

    discovered.sort(key=lambda t: t[0])
    return [t[1] for t in discovered]


def resolve_tab_dir(dir_name: str) -> str:
    """Follow `host` from a pages/ dir to the dir whose tab owns it.

    Returns dir_name unchanged when it hosts itself (the normal case). Chains
    are followed a few hops and a cycle just stops — a misconfigured pair of
    dirs pointing at each other must not hang the build."""
    seen = {dir_name}
    for _ in range(8):
        cfg = _load_tab_cfg(PAGES / dir_name)
        host = cfg.get("host")
        if not host or host in seen:
            return dir_name
        seen.add(host)
        dir_name = host
    return dir_name


# Eagerly evaluated for legacy consumers. Plug-and-play callers should
# prefer get_tabs() so the scan reruns each time.
TABS = get_tabs()


# ---------- title extraction ----------


class _TitleGrabber(HTMLParser):
    """Capture the <title> and the first <h1> from a page."""

    def __init__(self):
        super().__init__()
        self._in_title = False
        self._in_h1 = False
        self.title = ""
        self.h1 = ""
        self.nav_title = ""

    def handle_starttag(self, tag, attrs):
        if tag == "title" and not self.title:
            self._in_title = True
        elif tag == "h1" and not self.h1:
            self._in_h1 = True
        elif tag == "meta" and not self.nav_title:
            d = dict(attrs)
            if d.get("name") == "nav-title":
                self.nav_title = d.get("content") or ""

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "h1":
            self._in_h1 = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._in_h1:
            self.h1 += data


def _page_title(html_path: Path) -> str:
    try:
        text = html_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return html_path.stem
    g = _TitleGrabber()
    g.feed(text)
    # A <meta name="nav-title"> override wins (short label for sidebar +
    # breadcrumbs while the body <h1> keeps the long title). Otherwise prefer
    # the body's <h1>: it carries no " — <site>" suffix, so labels stay
    # correct after a site rename. Fall back to <title> with the suffix trimmed.
    explicit = g.nav_title.strip()
    title = explicit or g.h1.strip()
    if not title:
        title = g.title.strip()
        title = re.split(rf"\s+[—|·-]\s+{re.escape(SITE_NAME)}", title, maxsplit=1)[0].strip()
    # HTMLParser only decodes one layer of entities. Loop to be safe against
    # titles that recycled through `html.escape` multiple times.
    prev = None
    while title != prev:
        prev = title
        title = html.unescape(title)
    if not explicit:
        # A numbered <h1> badge (e.g. "<span>9</span>Visual Canvas Editor")
        # collapses to "9Visual…" once tags are stripped; restore a hyphen
        # separator. The lookahead excludes digits and whitespace so titles that
        # merely START with a number ("2026 上半年…") don't get backtrack-split
        # into "202 - 6 …". Skipped for an explicit nav-title: that label is
        # authored, not salvaged from markup, so it is used verbatim (otherwise
        # a label like "7-6 以来" renders as "7 - -6 以来").
        title = re.sub(r"^(\d+)(?=[^\d\s])", r"\1 - ", title)
    return html.escape(title) if title else html_path.stem


# ---------- per-page nav opt-out ----------

NAV_HIDDEN_RE = re.compile(r'<meta\s+name="nav-hidden"\s+content="([^"]*)"[^>]*>', re.IGNORECASE)
_HIDDEN_FALSEY = {"", "false", "0", "no", "off"}


def is_nav_hidden(html_path: Path) -> bool:
    """True when a page opts out of the sidebar tree via
    ``<meta name="nav-hidden" content="true">`` in its head.

    Display-only, and deliberately weaker than the gitignore switch above: the
    page still builds, still deploys, stays searchable, and stays reachable by
    URL or from an in-page link — it just isn't listed in the nav. Use it for
    pages that are linked from somewhere better than an alphabetical sidebar.
    """
    try:
        text = html_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    head_end = text.lower().find("</head>")
    m = NAV_HIDDEN_RE.search(text[:head_end] if head_end != -1 else text[:4000])
    return bool(m) and m.group(1).strip().lower() not in _HIDDEN_FALSEY


# ---------- discovery ----------

# Memoizes per-section tree discovery. Keyed ONLY on section config (dir / order
# / depth), never on directory contents — so it's a within-a-build optimization,
# not a long-lived store. A persistent process (the dev server) MUST call
# invalidate_discovery_cache() whenever pages are added/removed/renamed, else
# new pages stay invisible to sibling sidebars. See invalidate_discovery_cache().
_DISCOVER_CACHE: dict[str, list[dict]] = {}


def invalidate_discovery_cache() -> None:
    """Drop memoized page-tree discovery so the next render re-scans the tree.

    Cheap (just clears a dict). Long-lived callers that re-render after the page
    set may have changed — chiefly the live-reload dev server's per-change wrap —
    call this first so newly added/removed/renamed pages propagate into every
    sibling sidebar without a server restart. Also drops the gitignore snapshot
    so visibility follows .gitignore edits.
    """
    global _IGNORED_CACHE
    _IGNORED_CACHE = None
    global _MOUNT_CACHE
    _MOUNT_CACHE = None
    _DISCOVER_CACHE.clear()


def _nav_order(parent: Path) -> dict[str, int]:
    """Curated nav order for one directory's children, read from an optional
    `parent/_order.json` (a JSON list of names). Names may be subdirectory
    names or page stems — a directory's groups and its loose pages are ordered
    from the same list. Returns stem -> rank; anything unlisted sorts after the
    listed entries, alphabetically. Lets a folder pin nav order without
    renaming files or polluting URLs (the default filesystem scan is
    alphabetical).
    """
    order_file = parent / "_order.json"
    if not order_file.exists():
        return {}
    try:
        names = json.loads(order_file.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return {str(n): i for i, n in enumerate(names)} if isinstance(names, list) else {}


def _is_embedded_site(d: Path) -> bool:
    """True for a directory holding an embedded external site (`.nowrap`).

    Such a subtree ships its own chrome AND its own internal navigation, so the
    docs sidebar links to its landing page and never enumerates its interior —
    otherwise a single drop-in site would flood the tree with hundreds of its
    own pages. Same marker the wrapper uses to leave these pages alone.
    """
    return (d / ".nowrap").exists()


def _ordered_subdirs(parent: Path) -> list[Path]:
    """Subdirectories of `parent` in nav order (see `_nav_order`).
    Underscore/dot dirs are skipped.
    """
    dirs = [d for d in parent.iterdir() if d.is_dir() and not d.name.startswith(("_", "."))]
    priority = _nav_order(parent)
    return sorted(dirs, key=lambda d: (priority.get(d.name, len(priority)), d.name.lower()))


def _scan_dir(current: Path) -> list[dict]:
    """Recursive directory scan. index.html is consumed by the caller (it
    becomes the parent group's label/href), so this returns siblings + subdirs.
    """
    nodes: list[dict] = []
    priority = _nav_order(current)
    files = sorted(
        [f for f in current.glob("*.html") if f.name != "index.html" and not is_nav_hidden(f)],
        key=lambda p: (priority.get(p.stem, len(priority)), p.stem.lower()),
    )
    for f in files:
        nodes.append(
            {
                "kind": "page",
                "label": _page_title(f),
                "href": f.relative_to(V2).as_posix(),
            }
        )
    for d in _ordered_subdirs(current):
        idx = d / "index.html"
        if _is_embedded_site(d):
            if idx.exists():
                nodes.append(
                    {
                        "kind": "page",
                        "label": _page_title(idx),
                        "href": idx.relative_to(V2).as_posix(),
                    }
                )
            continue
        if idx.exists():
            label = _page_title(idx)
            href = idx.relative_to(V2).as_posix()
        else:
            label = _default_label(d.name)
            href = None
        nodes.append(
            {
                "kind": "group",
                "label": label,
                "href": href,
                "key": d.relative_to(V2).as_posix(),
                "children": _scan_dir(d),
            }
        )
    return nodes


def _scan_root(tab_dir: Path) -> list[dict]:
    """Nodes for a tab's whole sidebar in auto mode — the tab folder mirrored
    recursively. Unlike _scan_dir, the tab-root index.html IS surfaced as a page
    (no parent group consumes it); it just sorts first. Subfolders become
    collapsible dividers; their own index.html is their clickable default page."""
    nodes: list[dict] = []
    files = sorted(
        [f for f in tab_dir.glob("*.html") if not is_nav_hidden(f)],
        key=lambda p: (p.name != "index.html", p.stem.lower()),
    )
    for f in files:
        nodes.append(
            {"kind": "page", "label": _page_title(f), "href": f.relative_to(V2).as_posix()}
        )
    for d in _ordered_subdirs(tab_dir):
        idx = d / "index.html"
        if idx.exists():
            label = _page_title(idx)
            href = idx.relative_to(V2).as_posix()
        else:
            label = _default_label(d.name)
            href = None
        nodes.append(
            {
                "kind": "group",
                "label": label,
                "href": href,
                "key": d.relative_to(V2).as_posix(),
                "children": _scan_dir(d),
            }
        )
    return nodes


def _discover_tree(section: dict) -> list[dict]:
    """Return ordered tree nodes for a section's nav."""
    cache_key = "|".join(
        [
            section["dir"],
            "files_only" if section.get("files_only") else "",
            f"depth={section['depth_limit']}" if section.get("depth_limit") else "",
            f"order={','.join(section['order'])}" if section.get("order") else "",
            "only_listed" if section.get("only_listed") else "",
            "no_auto_index" if section.get("no_auto_index") else "",
            # Nested groups are part of the shape, so the whole spec goes in the
            # key — two groups can share dir+label yet differ deeper down.
            "groups=" + json.dumps(section.get("groups"), sort_keys=True, ensure_ascii=False)
            if section.get("groups")
            else "",
        ]
    )
    if cache_key in _DISCOVER_CACHE:
        return _DISCOVER_CACHE[cache_key]

    base = V2 / section["dir"]
    if not base.exists():
        _DISCOVER_CACHE[cache_key] = []
        return []

    files_only = section.get("files_only", False)
    depth_limit = section.get("depth_limit")
    curated_order: list[str] = section.get("order") or []
    order_index = {stem: i for i, stem in enumerate(curated_order)}

    def _top_sort_key(p: Path) -> tuple:
        if p.name == "index.html":
            return (0, 0, "")
        if p.stem in order_index:
            return (1, order_index[p.stem], "")
        # No curated order: sort by a leading <h1> number badge when present
        # (e.g. capabilities are numbered in the h1, not the filename), else
        # fall back to the filename stem.
        m = re.match(r"\s*(\d+)", _page_title(p))
        if m:
            return (2, int(m.group(1)), p.stem.lower())
        return (3, 0, p.stem.lower())

    top_files = sorted((f for f in base.glob("*.html") if not is_nav_hidden(f)), key=_top_sort_key)
    if section.get("only_listed"):
        keep_index = not section.get("no_auto_index")
        top_files = [
            f for f in top_files
            if f.stem in order_index or (keep_index and f.name == "index.html")
        ]
    nodes: list[dict] = [
        {"kind": "page", "label": _page_title(f), "href": f.relative_to(V2).as_posix()}
        for f in top_files
    ]

    # Virtual sub-groups: nest pages from another dir under this section
    # without moving files. Rendered as collapsible "group" nodes right
    # after the section's own pages. A group may carry its own `groups`,
    # so a section can nest more than one level deep.
    for grp in section.get("groups") or []:
        g_children = _discover_tree(
            {
                "dir": grp["dir"],
                "order": grp.get("order"),
                "only_listed": grp.get("only_listed"),
                "no_auto_index": grp.get("no_auto_index"),
                "groups": grp.get("groups"),
                "files_only": True,
            }
        )
        if g_children:
            nodes.append(
                {
                    "kind": "group",
                    "label": grp.get("label", ""),
                    "href": None,
                    "key": grp.get("nav_key") or grp["dir"],
                    "children": g_children,
                }
            )

    if files_only:
        _DISCOVER_CACHE[cache_key] = nodes
        return nodes

    if depth_limit == 2:
        for d in sorted([d for d in base.iterdir() if d.is_dir()]):
            idx = d / "index.html"
            if idx.exists():
                nodes.append(
                    {
                        "kind": "page",
                        "label": _page_title(idx),
                        "href": idx.relative_to(V2).as_posix(),
                    }
                )
        _DISCOVER_CACHE[cache_key] = nodes
        return nodes

    for d in _ordered_subdirs(base):
        idx = d / "index.html"
        if _is_embedded_site(d):
            if idx.exists():
                nodes.append(
                    {
                        "kind": "page",
                        "label": _page_title(idx),
                        "href": idx.relative_to(V2).as_posix(),
                    }
                )
            continue
        if idx.exists():
            label = _page_title(idx)
            href = idx.relative_to(V2).as_posix()
        else:
            label = d.name.replace("-", " ").replace("_", " ").title()
            href = None
        nodes.append(
            {
                "kind": "group",
                "label": label,
                "href": href,
                "key": d.relative_to(V2).as_posix(),
                "children": _scan_dir(d),
            }
        )
    _DISCOVER_CACHE[cache_key] = nodes
    return nodes


# ---------- rendering ----------


def render_top_header(active_tab: str, page_rel: str) -> str:
    """Render the sticky top header shell — logo, action buttons, and an EMPTY
    ``#site-tabs`` container.

    The tab links themselves are rendered client-side from ``assets/nav.json``
    (see ``assets/nav.js``) so that adding/removing a page or section doesn't
    force a re-bake of the tab strip into every page. ``active_tab`` is no longer
    consumed here — the client marks the active tab from ``<body data-tab>``."""
    prefix = "../" * page_rel.count("/")
    return f"""<header class="site-header">
  <div class="site-header-inner">
    <a class="site-logo" href="{prefix}index.html">{html.escape(SITE_NAME)}</a>
    <nav class="site-tabs" id="site-tabs" aria-label="Site sections"></nav>
    <div class="site-actions">
      <button class="site-action search-btn" aria-label="Search" title="Search (press /)">🔍</button>
      <button class="site-action share-btn" aria-label="Share" title="Share this page" aria-haspopup="true" aria-expanded="false">🔗</button>
      <button class="site-action theme-toggle" aria-label="Toggle theme" title="Toggle dark mode">🌙</button>
      <button class="site-action mobile-nav-toggle" aria-label="Menu" title="Menu">☰</button>
    </div>
  </div>
</header>"""


def _json_node(n: dict) -> dict:
    """Normalize a discovery node into the JSON shape the client consumes.

    Labels are un-escaped to raw text (the client assigns them via textContent,
    which re-escapes safely) — otherwise entities like ``&amp;`` would
    double-display."""
    out: dict = {"kind": n["kind"], "label": html.unescape(n.get("label", ""))}
    if n.get("href"):
        out["href"] = n["href"]
    if n.get("key"):
        out["key"] = n["key"]
    if n.get("children"):
        out["children"] = [_json_node(c) for c in n["children"]]
    return out


def _prune_private(nodes: list[dict]) -> list[dict]:
    """Drop gitignored pages/groups from a discovery tree (public view).

    Group/section nodes carry their dir in `key`; page nodes their file in
    `href`. An ignored dir prunes its whole subtree in one hit."""
    out: list[dict] = []
    for n in nodes:
        ref = n.get("key") or n.get("href")
        if ref and is_private_rel(ref):
            continue
        if n.get("children"):
            kids = _prune_private(n["children"])
            if not kids and not n.get("href"):
                continue  # a section/group whose every page was private: nothing left to show
            n = {**n, "children": kids}
        out.append(n)
    return out


def build_nav_data(include_private: bool = False) -> dict:
    """Serializable nav tree for client-side rendering.

    Single source of truth for the top tabs + left sidebar. Rendered in the
    browser by assets/nav.js, so adding/removing/renaming a page touches only
    that page's own file + this one JSON — never every sibling's baked chrome.
    hrefs are V2-relative ("pages/.../x.html"); the client prepends the page's
    data-asset-prefix so they resolve at any depth / under any Pages base path.

    The default (public) view drops gitignored tabs/pages — it is written to
    the committed assets/nav.json and is what the published site serves.
    include_private=True keeps them — written to the gitignored
    assets/nav.local.json, which the dev server serves in place of nav.json so
    local-only sections still show up locally (see _wrap_handwritten, _serve)."""
    tabs_out: list[dict] = []
    for tab in get_tabs(include_private=include_private):
        nodes: list[dict]
        if tab.get("external_layout"):
            # External-layout tabs (AAS) own their chrome; they still appear in
            # the top strip but have no docs-style sidebar to render.
            nodes = []
        elif tab.get("auto_nav"):
            nodes = [_json_node(n) for n in _scan_root(PAGES / tab["_dir"])]
        else:
            nodes = []
            for sec in tab["sections"]:
                children = _discover_tree(sec)
                if not children:
                    continue
                nodes.append(
                    {
                        "kind": "section",
                        "label": html.unescape(sec["label"]),
                        "key": sec.get("nav_key") or sec["dir"],
                        "children": [_json_node(c) for c in children],
                    }
                )
        if not include_private:
            nodes = _prune_private(nodes)
        tabs_out.append(
            {
                "tab": tab["tab"],
                "key": tab["key"],
                "dir": tab["_dir"],
                "landing": tab["landing"],
                "external_layout": bool(tab.get("external_layout")),
                "pinned": bool(tab.get("pinned")),
                "group": tab.get("group") or "",
                "nodes": nodes,
            }
        )
    return {"site_name": SITE_NAME, "tabs": tabs_out}


def asset_prefix(page_rel: str) -> str:
    depth = page_rel.count("/")
    return "../" * depth if depth else ""
