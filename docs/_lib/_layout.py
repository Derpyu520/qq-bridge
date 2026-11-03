#!/usr/bin/env python3
"""Shared HTML layout shell for docs/.

Every page goes: top header → 3-col grid (left sidebar | main | right TOC) → footer.
HTML is hand-authored; `_wrap_handwritten.py` runs this layout over content extracted
from `<main>` whenever nav/layout changes warrant a batch re-wrap.
"""

from __future__ import annotations

import html
from collections.abc import Sequence
from dataclasses import dataclass, field

from _nav import (
    asset_prefix,
    render_top_header,
)
from _site import BASE_URL, DESCRIPTION, FOOTER, OG_IMAGE, SITE_NAME


@dataclass
class PageMeta:
    """Per-page metadata builders pass to the layout shell."""

    tab: str  # "Developer Guide" or "Research"
    page_rel: str  # v2-relative href, e.g. "capabilities/graph-expressible-agents.html"
    browser_title: str  # <title> tag
    section_class: str = ""  # e.g. "capability", "designdoc", "research", "decisions"
    breadcrumbs: list = field(default_factory=list)  # list of (label, href) — last item is "here"
    last_updated: str = ""  # right-side text in topbar
    has_right_toc: bool = True
    description: str = ""  # <meta name="description"> / og:description; falls back to site default
    extra_head: str = ""  # raw HTML inserted before </head> (page-specific <style>)
    extra_body_end: str = ""  # raw HTML inserted before </body> (page-specific <script>)


def render_breadcrumbs(meta: PageMeta) -> str:
    if not meta.breadcrumbs:
        return ""
    parts = []
    n = len(meta.breadcrumbs)
    for i, (label, href) in enumerate(meta.breadcrumbs):
        safe_label = html.escape(label)
        if i == n - 1:
            parts.append(f'<span class="here">{safe_label}</span>')
        else:
            if href:
                parts.append(f'<a href="{html.escape(href)}">{safe_label}</a>')
            else:
                parts.append(safe_label)
        if i < n - 1:
            parts.append('<span class="sep">/</span>')
    crumbs = "\n    ".join(parts)
    # Emit the last-updated line only when present — otherwise the f-string would
    # leave a "  " (indent-only) line that trim-trailing-whitespace strips at
    # commit but the wrap re-adds, churning every page that has no last_updated.
    upd_line = (
        f'\n  <div class="last-updated">{meta.last_updated}</div>' if meta.last_updated else ""
    )
    return f"""<div class="topbar">
  <div class="crumbs">
    {crumbs}
  </div>{upd_line}
</div>"""


def render_right_toc(toc_entries: Sequence[tuple]) -> str:
    """toc_entries: iterable of (level, anchor_id, text) for h2/h3 headings."""
    if not toc_entries:
        return ""
    items = []
    for level, anchor, text in toc_entries:
        cls = "toc-h2" if level == 2 else "toc-h3"
        items.append(f'<a class="{cls}" href="#{anchor}">{text}</a>')
    items_block = "\n      ".join(items)
    return f"""<aside class="sidebar-right" aria-label="On this page">
  <div class="sidebar-inner">
    <span class="toc-label">On this page</span>
    <nav class="toc-list">
      {items_block}
    </nav>
  </div>
</aside>"""


def render_meta_tags(meta: PageMeta, prefix: str) -> str:
    """Description + OpenGraph/Twitter tags for link previews.

    `og:url`/`og:image` are absolute and therefore only emitted when `base_url`
    is configured in `_site.json`; `description`/`og:title`/`og:description`
    are relative and always emitted. The page title (already escaped, with the
    site-name suffix) doubles as `og:title`."""
    desc = html.escape(meta.description or DESCRIPTION)
    tags = [
        f'<meta name="description" content="{desc}">',
        f'<meta property="og:title" content="{meta.browser_title}">',
        f'<meta property="og:description" content="{desc}">',
        '<meta property="og:type" content="website">',
        f'<meta property="og:site_name" content="{html.escape(SITE_NAME)}">',
        '<meta name="twitter:card" content="summary_large_image">',
    ]
    if BASE_URL:
        page_url = f"{BASE_URL}/{meta.page_rel}"
        tags.append(f'<meta property="og:url" content="{html.escape(page_url)}">')
        if OG_IMAGE:
            img_url = f"{BASE_URL}/{OG_IMAGE}"
            tags.append(f'<meta property="og:image" content="{html.escape(img_url)}">')
            tags.append(f'<meta name="twitter:image" content="{html.escape(img_url)}">')
    return "\n".join(tags)


def render(meta: PageMeta, body_html: str, toc_entries: Sequence[tuple] = ()) -> str:
    """Assemble the full HTML page."""
    prefix = asset_prefix(meta.page_rel)
    top = render_top_header(meta.tab, meta.page_rel)
    # The sidebar tree is rendered client-side from assets/nav.json (assets/nav.js).
    # We bake only the empty container so a page add/remove never re-bakes siblings;
    # data-tab / data-page-rel on <body> let the client mark the active tab + page.
    sidebar = (
        '<aside class="sidebar-left" id="sidebar-left" aria-label="Section navigation">'
        '<div class="sidebar-inner"></div></aside>'
    )
    breadcrumbs = render_breadcrumbs(meta)
    right_toc = render_right_toc(toc_entries) if meta.has_right_toc else ""

    layout_class = "site-layout" + (" has-right-toc" if right_toc else " no-right-toc")
    body_class = "doc-body " + meta.section_class

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{meta.browser_title}</title>
{render_meta_tags(meta, prefix)}
<link rel="icon" href="{prefix}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{prefix}assets/style.css">
<script>
  // Apply theme before paint to avoid flash.
  (function() {{
    var t = localStorage.getItem('site-theme');
    if (!t) {{ t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }}
    document.documentElement.setAttribute('data-theme', t);
  }})();
</script>
{meta.extra_head}
</head>
<body data-asset-prefix="{prefix}" data-tab="{html.escape(meta.tab)}" data-page-rel="{html.escape(meta.page_rel)}">

{top}

<div class="{layout_class}">

{sidebar}

<main class="{body_class}">
  {breadcrumbs}
  {body_html}

  <footer>
    <span>{html.escape(FOOTER)}</span>
  </footer>
</main>

{right_toc}

</div>

<script src="{prefix}assets/nav.js"></script>
{meta.extra_body_end}
</body>
</html>
"""
