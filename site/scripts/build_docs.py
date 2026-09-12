# /// script
# requires-python = ">=3.11"
# dependencies = ["Markdown>=3.7,<4", "Pygments>=2.18,<3"]
# ///
"""Build the developer guide as one scrollable page from reviewed Markdown.

Code blocks are highlighted at build time with Pygments (classes only, styled
in guide.css), so the page ships no highlighting script.

Every source page becomes a section of guide/index.html with a stable id, a
"Copy as Markdown" control and a Markdown twin (guide/<slug>.md). The old
per-page URLs remain as redirect stubs. No client-side Markdown rendering.
"""
from pathlib import Path
import html
import json
import re
import markdown

SITE = Path(__file__).resolve().parents[1]
REPO = SITE.parent
PAGES = [
    ('index', 'Overview'), ('quickstart', 'Quickstart'), ('sessions', 'Sessions and streaming'),
    ('cli', 'CLI'), ('recipes', 'Recipes'), ('configuration', 'Configuration'),
    ('permissions', 'Permissions and cleanup'), ('api', 'TypeScript reference'),
    ('cli-reference', 'CLI reference'), ('troubleshooting', 'Troubleshooting'),
]
SLUGS = [slug for slug, _ in PAGES]


def rewrite_links(body, slug, title_ids):
    """Point every cross-page and in-page link at the single page's anchors."""
    def cross(match):
        target, anchor = match.group(1), match.group(2)
        if anchor and anchor != title_ids.get(target):
            return f'href="#{target}--{anchor}"'
        return f'href="#{target}"'
    body = re.sub(r'href="([a-z-]+)\.html(?:#([^"]+))?"', cross, body)
    body = re.sub(r'href="#([^"]+)"', lambda m: m.group(0) if m.group(1).startswith(tuple(f'{s}--' for s in SLUGS)) or m.group(1) in SLUGS else f'href="#{slug}--{m.group(1)}"', body)
    return body


def build():
    output = SITE / 'guide'
    output.mkdir(exist_ok=True)
    help_file = REPO / 'src/cli/help.ts'
    try:
        help_source = help_file.read_text()
    except FileNotFoundError:
        raise SystemExit('CLI help source missing: expected src/cli/help.ts at the repository root.')
    sources, title_ids, converted = {}, {}, {}
    for slug, label in PAGES:
        source = (SITE / f'docs/guide/{slug}.md').read_text()
        if slug == 'cli-reference':
            for marker, symbol in [('CLI_HELP', 'cliHelp'), ('CONFIG_HELP', 'cliConfigHelp')]:
                match = re.search(r'export const ' + symbol + r' = `([\s\S]*?)`;', help_source)
                if not match:
                    raise SystemExit(f'Cannot locate {symbol}; review the CLI help export before rebuilding.')
                source = source.replace(f'<!-- {marker} -->', '```text\n' + match[1].strip() + '\n```')
        md = markdown.Markdown(extensions=['fenced_code', 'tables', 'toc', 'codehilite'], extension_configs={'toc': {'permalink': False}, 'codehilite': {'css_class': 'highlight', 'guess_lang': False, 'noclasses': False}})
        body = md.convert(source)
        title = source.splitlines()[0].removeprefix('# ')
        title_ids[slug] = md.toc_tokens[0]['id'] if md.toc_tokens else ''
        sources[slug] = source
        converted[slug] = (body, title, md.toc_tokens)
    sections, sidebar, search, full = [], [], [], []
    for slug, label in PAGES:
        body, title, tokens = converted[slug]
        body = re.sub(r'<h1 id="[^"]*">', f'<h1 id="{slug}--title">', body, count=1)
        body = re.sub(r'<(h[2-6]) id="([^"]+)">', lambda m: f'<{m.group(1)} id="{slug}--{m.group(2)}">', body)
        body = rewrite_links(body, slug, title_ids)
        subsections = tokens[0]['children'] if tokens else []
        sections.append(f'<section class="doc-section" id="{slug}" aria-labelledby="{slug}--title"><div class="section-tools"><span>{html.escape(label)}</span><button class="copy-section" data-slug="{slug}">Copy as Markdown</button><a href="{slug}.md">.md</a></div>{body}</section>')
        subs = ''.join(f'<li><a href="#{slug}--{t["id"]}">{html.escape(t["name"])}</a></li>' for t in subsections)
        sidebar.append(f'<li><a href="#{slug}" data-section="{slug}">{html.escape(label)}</a><ul>{subs}</ul></li>')
        full.append(sources[slug])
        search.append({'title': title, 'label': label, 'url': f'#{slug}', 'text': re.sub(r'[`#*|]', '', sources[slug])})
        (output / f'{slug}.md').write_text(sources[slug])
        if slug != 'index':
            (output / f'{slug}.html').write_text(f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=./#{slug}"><title>{html.escape(label)} — Elwood docs</title></head><body><p>The guide is one page now: <a href="./#{slug}">{html.escape(label)}</a>.</p></body></html>')
    page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#fbf6e7"><link rel="icon" href="../assets/landing/favicon.ico" sizes="16x16 32x32 48x48"><link rel="icon" href="../assets/landing/icon-512.webp" type="image/webp" sizes="512x512"><link rel="apple-touch-icon" href="../assets/landing/apple-touch-icon.png"><link rel="manifest" href="../assets/landing/site.webmanifest"><meta name="description" content="Documentation for the Elwood TypeScript library and CLI: what it does, how it does it, and how to use it."><title>Elwood documentation</title><link rel="stylesheet" href="guide.css"></head>
<body><a class="skip" href="#content">Skip to content</a><header class="docs-header"><a class="docs-brand" href="../">ELWOOD <span>/ documentation</span></a><nav aria-label="Site"><a href="../">Home</a><a href="https://www.npmjs.com/package/@with-logic/elwood">npm ↗</a><button id="search-open" aria-haspopup="dialog">Search <kbd>⌘ K</kbd></button></nav></header>
<div class="docs-layout"><aside class="docs-sidebar"><p class="sidebar-title">Contents</p><nav aria-label="Documentation"><ul>{''.join(sidebar)}</ul></nav></aside>
<main id="content" tabindex="-1"><article>{''.join(sections)}</article></main><aside class="docs-tools" aria-label="Copy and export"><p>For your agent</p><button class="tool-copy" id="copy-all-side" type="button">Copy docs as Markdown</button><a class="plain-text" href="../llms-full.txt">llms-full.txt</a><a class="plain-text" href="../llms.txt">llms.txt</a></aside></div>
<dialog id="docs-search" aria-labelledby="search-title"><div class="search-heading"><h2 id="search-title">Search</h2><button id="search-close" aria-label="Close search">×</button></div><label for="search-query">Search the documentation</label><input id="search-query" type="search" placeholder="streaming, timeout, resume…" autocomplete="off"><p id="search-status" role="status"></p><ul id="search-results"></ul></dialog><script type="module" src="guide.mjs"></script></body></html>'''
    (output / 'index.html').write_text(page)
    (output / 'search.json').write_text(json.dumps(search, ensure_ascii=False))
    (SITE / 'llms-full.txt').write_text('\n\n---\n\n'.join(full))
    (SITE / 'llms.txt').write_text('# Elwood\n\n> A TypeScript library and CLI for driving Claude Code and Codex through real interactive terminals. Package: @with-logic/elwood.\n\n' + '\n'.join(f'- [{label}](guide/{slug}.md)' for slug, label in PAGES) + '\n\n[Full documentation](llms-full.txt)\n')
    print(f'Built one guide page with {len(PAGES)} sections, Markdown copies, redirect stubs, search index and llms exports.')


if __name__ == '__main__':
    build()
