#!/usr/bin/env python3
"""Re-wrap every doc-site HTML page with the current layout shell.

The site is HTML-first — each `<main>` block holds the authored content; the
chrome (top header, breadcrumbs, sidebar, right-TOC, footer) is regenerated
from `_layout.py` + `_nav.py`. Run this any time you change layout/nav and
want the new chrome propagated to all pages.

Targets:
  - docs/index.html              — root landing
  - docs/pages/**/*.html         — every doc page

For each page we:
  1. Read existing <title>, <main> inner content, and last-updated text
  2. Strip the layout-regenerated topbar from inside <main>
  3. Re-render via `_layout.render(meta, body, toc)` with auto-derived metadata
  4. Write back, idempotent (CONVERTED_MARKER guards against double-wrap)

A small HANDWRITTEN dict at the top supplies per-page overrides (e.g. spine
pages with custom section_class). Everything else gets metadata derived from
its path.
"""

from __future__ import annotations

import html
import json
import os
import re
from pathlib import Path

import _layout
import _nav
from _site import SITE_NAME

# docs/ root — script lives at docs/_lib/_wrap_handwritten.py.
V2 = Path(__file__).resolve().parent.parent

# Per-page overrides. Any field absent here is auto-derived. Keys are paths
# relative to docs/. Add an entry here only when a page needs chrome that
# can't be inferred from its path (e.g. the root landing has no sidebar
# section, so its right-TOC is suppressed). Everything else is automatic.
HANDWRITTEN: dict[str, dict] = {
    "index.html": {
        "section_class": "blueprint",
        "breadcrumbs": [(SITE_NAME, "")],
        "has_right_toc": False,
    },
    # Developer Guide "Core" spine pages — accents that can't be inferred from
    # the path (they all live directly under core/).
    "pages/dev/core/blueprint.html": {"section_class": "blueprint"},
    "pages/dev/core/architecture.html": {"section_class": "architecture"},
    "pages/dev/core/codebase-map.html": {"section_class": "codebase"},
    "pages/dev/core/glossary.html": {"section_class": "glossary"},
}

# Per-section accent (CSS class names defined in assets/style.css). The first
# matching path-prefix wins, so list more-specific prefixes first. Unmatched
# pages fall back to "guide". Accents are purely cosmetic.
SECTION_CLASS_BY_PREFIX = (
    ("pages/dev/design-docs/", "designdoc"),
    ("pages/dev/security/", "decisions"),
    ("pages/dev/", "guide"),
    ("pages/records/", "research"),
)

# Pretty labels for directory names that don't title-case cleanly. Most dirs
# render fine from auto title-casing ("getting-started" → "Getting Started");
# add a row only when that's wrong.
DIR_LABEL_OVERRIDES: dict[str, str] = {
    "use": "使用指南", "dev": "Developer Guide", "records": "记录",
    "core": "Core", "design-docs": "Design docs", "security": "Security", "contributing": "Contributing",
    "adaptation": "版本适配", "reviews": "核查", "tmp": "tmp",
}

# Marker we drop into the file so we know we already converted it.
CONVERTED_MARKER = "<!-- site-layout -->"

TITLE_RE = re.compile(r"<title>(.*?)</title>", re.DOTALL | re.IGNORECASE)
STYLE_RE = re.compile(r"<style[^>]*>.*?</style>", re.DOTALL | re.IGNORECASE)
NAV_TITLE_RE = re.compile(r'<meta\s+name="nav-title"\s+content="([^"]*)"[^>]*>', re.IGNORECASE)
NAV_HIDDEN_RE = re.compile(r'<meta\s+name="nav-hidden"\s+content="([^"]*)"[^>]*>', re.IGNORECASE)
SCRIPT_RE = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>.*?</script>", re.DOTALL | re.IGNORECASE)
BODY_RE = re.compile(r"<body[^>]*>(.*?)</body>", re.DOTALL | re.IGNORECASE)
MAIN_RE = re.compile(r'<main\s+class="doc-body[^"]*"[^>]*>(.*?)</main>', re.DOTALL | re.IGNORECASE)
LAST_UPDATED_RE = re.compile(r'<div class="last-updated">(.*?)</div>', re.DOTALL | re.IGNORECASE)
H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.DOTALL | re.IGNORECASE)
H2_ID_RE = re.compile(r'<h([23])[^>]*\bid="([^"]+)"[^>]*>(.*?)</h\1>', re.DOTALL | re.IGNORECASE)
P_RE = re.compile(r"<p[^>]*>(.*?)</p>", re.DOTALL | re.IGNORECASE)

# Cap a page's description and search text so the meta tags stay tidy and the
# generated search-index.json stays bounded. SEARCH_TEXT_MAX covers every page
# the template ships in full; on a very large KB, text past the cap on unusually
# long pages won't be searchable (titles + lead text always are) — raise it if
# you need deep recall and don't mind a bigger index.
DESC_MAX = 200
SEARCH_TEXT_MAX = 8000

def _dir_label(name: str) -> str:
    return DIR_LABEL_OVERRIDES.get(name, name.replace("-", " ").replace("_", " ").title())


def _strip_html_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text).strip()


def _plain_text(html_fragment: str) -> str:
    """Strip tags, unescape entities, and collapse whitespace to one line."""
    text = html.unescape(re.sub(r"<[^>]+>", " ", html_fragment))
    return re.sub(r"\s+", " ", text).strip()


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip() + "…"


def _tab_for(rel: str) -> str:
    """Active tab label for a page at `rel` (path relative to docs/).

    Tabs are scanned from docs/pages/<dir>/ (see _nav.get_tabs), so this
    is plug-and-play — no hardcoded tab names. Pages outside pages/
    (e.g. the root index.html) fall back to the first discovered tab."""
    tabs = _nav.get_tabs()
    if not tabs:
        return SITE_NAME
    parts = rel.split("/")
    if len(parts) >= 2 and parts[0] == "pages":
        # A dir with `host` has no tab of its own — its pages belong to the
        # host's tab, so they get its sidebar and its active tab marker.
        owner = _nav.resolve_tab_dir(parts[1])
        for t in tabs:
            if t.get("_dir") == owner:
                return t["tab"]
    return tabs[0]["tab"]


def _section_class_for(rel: str) -> str:
    for prefix, cls in SECTION_CLASS_BY_PREFIX:
        if rel.startswith(prefix):
            return cls
    return "guide"


def _auto_breadcrumbs(rel: str, title: str) -> list:
    """Derive page-relative breadcrumbs from the docs-relative page path."""
    if rel == "index.html":
        return [(SITE_NAME, "")]
    parts = rel.split("/")
    output_dir = (V2 / rel).parent

    def relhref(target_abs: Path) -> str:
        return os.path.relpath(target_abs, output_dir)

    crumbs: list = [(SITE_NAME, relhref(V2 / "index.html"))]
    accum: list[str] = []
    for seg in parts[:-1]:
        accum.append(seg)
        idx_abs = V2 / "/".join(accum) / "index.html"
        href = relhref(idx_abs) if idx_abs.exists() else ""
        crumbs.append((_dir_label(seg), href))
    if parts[-1] == "index.html":
        # Section landing — mark the last existing crumb as self (empty href)
        if crumbs:
            crumbs[-1] = (crumbs[-1][0], "")
    else:
        crumbs.append((title, ""))
    return crumbs


def _toc_from_body(body_html: str) -> list:
    """Build (level, anchor, text) tuples from <h2 id=...> and <h3 id=...> in body."""
    entries = []
    for m in H2_ID_RE.finditer(body_html):
        level = int(m.group(1))
        anchor = m.group(2)
        text = _strip_html_tags(m.group(3))
        entries.append((level, anchor, text))
    return entries


def render_page(path: Path) -> tuple[str, str, dict]:
    """Bake one page in memory: (wrapped html, the file's current text, its
    search-index entry). Raises ValueError when the file has neither <main> nor
    <body>. convert() is this plus the write; the dev server calls this alone for
    live-mounted pages (see mount_dirs), which are never written."""
    rel = path.relative_to(V2).as_posix()
    raw = path.read_text(encoding="utf-8")
    already_wrapped = CONVERTED_MARKER in raw

    # Pull title
    m = TITLE_RE.search(raw)
    title = m.group(1).strip() if m else path.stem
    title_suffix = f" — {SITE_NAME}"
    if title_suffix in title:
        title = title.split(title_suffix, 1)[0].strip()
    # Fully unescape so the eventual html.escape at render time produces exactly
    # one layer (idempotent). Without this loop, each re-wrap pass doubles every
    # `&amp;` (e.g. "&amp;" → "&amp;amp;"), and titles with `&` grow unbounded.
    prev = None
    while title != prev:
        prev = title
        title = html.unescape(title)

    # Pull style blocks from head only
    head_end = raw.lower().find("</head>")
    head_part = raw[:head_end] if head_end != -1 else ""
    styles = STYLE_RE.findall(head_part)
    extra_head = "\n".join(styles)
    # Short nav label override: re-emit into extra_head so it survives the
    # head regeneration (wrap only carries styles + this meta forward).
    m_nav = NAV_TITLE_RE.search(head_part)
    nav_title = html.unescape(m_nav.group(1).strip()) if m_nav else ""
    if nav_title:
        extra_head = f'<meta name="nav-title" content="{html.escape(nav_title)}">\n' + extra_head
    # Sidebar opt-out (see _nav.is_nav_hidden): same deal — carry it forward or
    # the page reappears in the nav on the next re-bake.
    m_hidden = NAV_HIDDEN_RE.search(head_part)
    if m_hidden:
        hidden = html.escape(html.unescape(m_hidden.group(1).strip()))
        extra_head = f'<meta name="nav-hidden" content="{hidden}">\n' + extra_head

    # Extract last_updated from topbar (before stripping it)
    last_updated = ""
    m_lu = LAST_UPDATED_RE.search(raw)
    if m_lu:
        last_updated = _strip_html_tags(m_lu.group(1)).strip()

    # Pick content body — always prefer the innermost <main class="doc-body">,
    # which preserves authored content across layout changes. The CONVERTED_MARKER
    # check is now informational; we rely on the presence of <main>, not the marker.
    main_matches = list(MAIN_RE.finditer(raw))
    if main_matches:
        # Innermost match: take the last one (handles accidentally double-wrapped pages).
        body_inner = main_matches[-1].group(1)
    else:
        m = BODY_RE.search(raw)
        if not m:
            raise ValueError("no <body> and no <main>")
        body_inner = m.group(1)
    _ = already_wrapped  # silence unused-variable lint

    # Pull and remove trailing <script> blocks (preserve them)
    inline_scripts = SCRIPT_RE.findall(body_inner)
    body_inner = SCRIPT_RE.sub("", body_inner)
    # A previous pass already moved these below </main>, where the extraction
    # above cannot see them — so re-collect from the tail too, else every
    # re-bake after the first silently drops the page's own scripts. The
    # layout's own <script src=...> is excluded by SCRIPT_RE (it has a src).
    if main_matches:
        inline_scripts += SCRIPT_RE.findall(raw[main_matches[-1].end():])
    extra_body_end = "\n".join(inline_scripts)

    # Strip layout-regenerated topbar
    body_inner = re.sub(
        r'<div class="topbar">\s*<div class="crumbs">.*?</div>\s*(?:<div class="last-updated">.*?</div>\s*)?</div>',
        "",
        body_inner,
        count=1,
        flags=re.DOTALL,
    )
    # Strip the layout-regenerated footer (single <span> inside <footer>) that a
    # prior wrap pass baked into body_inner — otherwise each re-wrap stacks another.
    # Structural match so it keeps working when site_name (and thus the footer
    # text) changes between passes.
    body_inner = re.sub(
        r"<footer>\s*<span>[^<]*</span>\s*</footer>",
        "",
        body_inner,
        flags=re.IGNORECASE,
    )
    body_inner = body_inner.strip()

    # Prefer the body's <h1> as the authoritative page title: it never carries the
    # " — <site>" suffix, so it survives a site rename cleanly (deriving the title
    # only from the existing <title> would re-append the new suffix and leave the
    # old name stranded — "Guide — Old — New"). Fall back to the <title> otherwise.
    m_h1 = H1_RE.search(body_inner)
    if m_h1:
        h1_text = html.unescape(_strip_html_tags(m_h1.group(1)))
        if h1_text:
            title = h1_text

    # Auto-derive overridable fields, then layer HANDWRITTEN overrides on top
    overrides = HANDWRITTEN.get(rel, {})
    tab = overrides.get("tab", _tab_for(rel))
    section_class = overrides.get("section_class", _section_class_for(rel))
    breadcrumbs = overrides.get("breadcrumbs", _auto_breadcrumbs(rel, nav_title or title))
    has_right_toc = overrides.get("has_right_toc", True)

    toc = _toc_from_body(body_inner)

    # Page description for <meta>/OpenGraph: the first paragraph, trimmed. Empty
    # when the page has no <p> (e.g. a pure-list page) — the layout then falls
    # back to the site-wide default. The <h1> heading is excluded by design.
    description = ""
    m_p = P_RE.search(body_inner)
    if m_p:
        description = _truncate(_plain_text(m_p.group(1)), DESC_MAX)

    meta = _layout.PageMeta(
        tab=tab,
        page_rel=rel,
        # Append the site-name suffix, except when the page title already IS the
        # site name (the root landing) — avoids a redundant "Foo — Foo" tab title.
        browser_title=html.escape(title) + (f" — {SITE_NAME}" if title != SITE_NAME else ""),
        section_class=section_class,
        breadcrumbs=breadcrumbs,
        last_updated=last_updated,
        has_right_toc=has_right_toc,
        description=description,
        extra_head=extra_head,
        extra_body_end=extra_body_end,
    )

    # Search-index entry — built from the same parsed content, so it always
    # matches what's actually on the page (title + full body text, trimmed).
    entry = {
        "title": title,
        "url": rel,
        "text": _truncate(_plain_text(body_inner), SEARCH_TEXT_MAX),
    }

    output = _layout.render(meta, body_inner, toc)
    output = output.replace("</head>", f"{CONVERTED_MARKER}\n</head>", 1)
    return output, raw, entry


def convert(path: Path) -> tuple[bool, dict | None]:
    try:
        output, raw, entry = render_page(path)
    except ValueError as e:
        print(f"  SKIP ({e}): {path.relative_to(V2).as_posix()}")
        return False, None
    # Write only when something actually changed. Keeps mtimes stable so the
    # dev server's auto-wrap doesn't see its own output as a new change and loop.
    changed = output != raw
    if changed:
        path.write_text(output, encoding="utf-8")
    return changed, entry


# ---------- live mounts ----------
# A symlinked directory under pages/ is a live mount: another repo's page tree
# shown as a divider of this site. The pages are that repo's files, so the
# wrapper never writes them (their own site bakes its own chrome into them);
# the dev server re-wraps them in memory per request (render_page), the watcher
# follows the link so an edit over there reloads the browser here, and they are
# listed in the LOCAL nav/search only (_nav.is_private_rel treats a mount as
# private) — the link exists on one machine, so the published site must not
# point at it.


def mount_dirs() -> list[Path]:
    """Every symlinked directory under pages/ (unresolved paths, sorted)."""
    pages_dir = V2 / "pages"
    if not pages_dir.exists():
        return []
    out: list[Path] = []
    for dirpath, dirnames, _files in os.walk(pages_dir):
        for d in dirnames:
            p = Path(dirpath) / d
            if p.is_symlink() and p.is_dir():
                out.append(p)
    return sorted(out)


def is_mounted(path: Path) -> bool:
    """True when `path` (unresolved, under docs/) sits inside a live mount."""
    p = path
    while p != V2 and p != p.parent:
        if p.is_symlink():
            return True
        p = p.parent
    return False


def mounted_pages() -> list[Path]:
    """The .html files inside every live mount, by their in-site (unresolved) path."""
    pages: list[Path] = []
    for d in mount_dirs():
        pages.extend(sorted(d.rglob("*.html")))
    return pages


def discover_all_pages() -> list[Path]:
    """All .html files under docs/ that should be re-wrapped.

    Skips tab dirs marked `external_layout: true` in their `_tab.json` —
    those pages own their chrome and the wrapper would mangle them.

    Also skips any subtree containing a `.nowrap` marker file — the
    sub-directory equivalent of `external_layout` for embedding a foreign
    static site (own styles/scripts) inside a normal tab. Marked pages keep
    their chrome, stay out of the search index, and are linked from the nav
    only where a `_tab.json` section points at them.
    """
    pages: list[Path] = []
    root_index = V2 / "index.html"
    if root_index.exists():
        pages.append(root_index)
    pages_dir = V2 / "pages"
    if not pages_dir.exists():
        return pages
    external_dirs = {t["_dir"] for t in _nav.get_tabs() if t.get("external_layout")}
    nowrap_dirs = {m.parent for m in pages_dir.rglob(".nowrap")}
    for f in sorted(pages_dir.rglob("*.html")):
        rel = f.relative_to(V2)
        # rel.parts[0] == "pages"; parts[1] is the tab dir
        if len(rel.parts) >= 2 and rel.parts[1] in external_dirs:
            continue
        if any(d in f.parents for d in nowrap_dirs):
            continue
        pages.append(f)
    return pages


SEARCH_INDEX_FILE = V2 / "assets" / "search-index.json"
SEARCH_INDEX_LOCAL_FILE = V2 / "assets" / "search-index.local.json"
NAV_JSON_FILE = V2 / "assets" / "nav.json"
NAV_JSON_LOCAL_FILE = V2 / "assets" / "nav.local.json"


def _write_json_asset(path: Path, data) -> bool:
    """Serialize + write one client-consumed JSON asset; True if it changed.
    Compact separators keep the output deterministic; the trailing newline keeps
    the file stable under end-of-file-fixer (otherwise every wrap re-dirties it
    and the pre-commit hook fights it forever). Writing only on change keeps
    mtimes stable so the dev server's auto-wrap doesn't see its own output as a
    new change and loop."""
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n"
    try:
        if path.exists() and path.read_text(encoding="utf-8") == payload:
            return False
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    return True


def _write_nav_json() -> int:
    """Write the client-rendered nav data (see _nav.build_nav_data + assets/nav.js):
    the committed assets/nav.json holds the public view (gitignored sections
    dropped — they never deploy, so listing them would leak titles and create
    dead links on the published site); the gitignored assets/nav.local.json
    holds the full view and is served in place of nav.json by the dev server,
    so local-only sections still show up locally. Returns files changed."""
    n = 0
    n += _write_json_asset(NAV_JSON_FILE, _nav.build_nav_data())
    n += _write_json_asset(NAV_JSON_LOCAL_FILE, _nav.build_nav_data(include_private=True))
    return n


def _write_search_index(entries: list[dict]) -> int:
    """Write the client-side search data (consumed by nav.js), split the same
    way as the nav data: committed search-index.json = public pages only
    (gitignored ones dropped), gitignored search-index.local.json = everything,
    served in its place by the dev server. Returns files changed."""
    entries = sorted(entries, key=lambda e: e["url"])
    public = [e for e in entries if not _nav.is_private_rel(e["url"])]
    n = 0
    n += _write_json_asset(SEARCH_INDEX_FILE, public)
    n += _write_json_asset(SEARCH_INDEX_LOCAL_FILE, entries)
    return n


def main(quiet: bool = False) -> int:
    """Re-wrap all pages and regenerate the search index. Returns the number of
    files actually changed. `quiet` suppresses the per-run summary (dev server)."""
    # A full wrap == "rebuild the site", so re-discover the page tree from disk.
    # In a one-shot CLI run this is a no-op (cache starts empty); in the live
    # dev server — which keeps _nav imported across rebuilds — it's what lets a
    # newly added/removed/renamed page show up in sibling sidebars without a
    # restart. The cache still amortizes discovery across this single pass.
    _nav.invalidate_discovery_cache()
    n_ok = 0
    n_skip = 0
    entries: list[dict] = []
    for path in discover_all_pages():
        try:
            changed, entry = convert(path)
            if entry is not None:
                entries.append(entry)
            if changed:
                n_ok += 1
            else:
                n_skip += 1
        except Exception as e:
            print(f"  ERROR {path.relative_to(V2)}: {type(e).__name__}: {e}")
            n_skip += 1
    # Live-mounted pages: indexed for local search, never written (see mount_dirs).
    for path in mounted_pages():
        try:
            entries.append(render_page(path)[2])
        except Exception as e:
            print(f"  ERROR (mount) {path.relative_to(V2)}: {type(e).__name__}: {e}")
    n_ok += _write_search_index(entries)
    n_ok += _write_nav_json()
    if not quiet:
        print(f"\ndone — {n_ok} written, {n_skip} unchanged/skipped")

    return n_ok


if __name__ == "__main__":
    main()
