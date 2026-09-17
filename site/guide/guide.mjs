export function indexPages(pages) {
  return pages.map(page => ({ ...page, searchText: page.text.toLowerCase(), searchTitle: `${page.title} ${page.label ?? ''}`.toLowerCase() }));
}
export function searchPages(pages, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return pages.slice(0, 5);
  return pages.map(page => {
    const body = page.searchText ?? page.text.toLowerCase(), title = page.searchTitle ?? `${page.title} ${page.label ?? ''}`.toLowerCase();
    const score = words.every(word => body.includes(word) || title.includes(word)) ? words.reduce((n, word) => n + (title.includes(word) ? 10 : 1), 0) : 0;
    return { ...page, score };
  }).filter(page => page.score).sort((a, b) => b.score - a.score).slice(0, 8);
}
// The heading currently "in view" is the last one whose top has scrolled past
// the sticky header; before any heading, the first one counts.
export function currentHeading(headings, scrollTop, offset = 110) {
  let current = headings[0] ?? null;
  for (const heading of headings) if (heading.top - scrollTop <= offset) current = heading; else break;
  return current;
}

if (typeof document !== 'undefined') {
  const dialog = document.querySelector('#docs-search'), input = document.querySelector('#search-query');
  const results = document.querySelector('#search-results'), status = document.querySelector('#search-status');
  let pages, loading, previousFocus;
  function render() {
    if (!pages) return;
    const query = input.value.trim().toLowerCase(), matches = searchPages(pages, query);
    results.replaceChildren(...matches.map(page => {
      const li = document.createElement('li'), link = document.createElement('a'), title = document.createElement('strong'), description = document.createElement('span');
      link.href = page.url; title.textContent = page.title;
      const position = Math.max(0, page.searchText.indexOf(query) - 45);
      description.textContent = page.text.slice(position, position + 160).replace(/\s+/g, ' ') + '…';
      link.append(title, description); link.addEventListener('click', () => dialog.close()); li.append(link); return li;
    }));
    status.textContent = matches.length ? `${matches.length} ${matches.length === 1 ? 'section' : 'sections'} found` : 'No matches. Try a shorter phrase, such as “resume” or “JSON”.';
  }
  async function open() {
    if (dialog.open) return;
    previousFocus = document.activeElement; dialog.showModal(); input.focus();
    if (pages) { render(); return; }
    status.textContent = 'Loading the index…';
    try {
      loading ??= fetch('/guide/search.json').then(response => { if (!response.ok) throw Error('index'); return response.json(); }).then(indexPages).finally(() => { loading = null; });
      pages = await loading; render();
    } catch { status.textContent = 'Search could not load. Close this panel and use the contents list, or reopen to retry.'; }
  }
  document.querySelector('#search-open').addEventListener('click', open);
  document.querySelector('#search-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => previousFocus?.focus({ preventScroll: true }));
  input.addEventListener('input', render);
  document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); dialog.open ? dialog.close() : open(); } });

  // Copy: one code block, one section as Markdown, or the whole guide.
  async function copyText(button, text, idle) {
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
    catch { button.textContent = 'Copy failed'; }
    setTimeout(() => { button.textContent = idle; }, 2000);
  }
  for (const pre of document.querySelectorAll('pre')) {
    const wrapper = document.createElement('div'), button = document.createElement('button');
    wrapper.className = 'code-wrap'; button.className = 'copy-code'; button.textContent = 'Copy'; button.setAttribute('aria-label', 'Copy code example');
    pre.before(wrapper); wrapper.append(pre, button);
    button.addEventListener('click', () => copyText(button, pre.textContent, 'Copy'));
  }
  const markdown = new Map();
  async function fetchText(url) {
    if (!markdown.has(url)) markdown.set(url, fetch(url).then(response => { if (!response.ok) throw Error(url); return response.text(); }).catch(error => { markdown.delete(url); throw error; }));
    return markdown.get(url);
  }
  for (const button of document.querySelectorAll('.copy-section')) {
    button.addEventListener('click', async () => {
      button.textContent = 'Copying…';
      try { await copyText(button, await fetchText(`/guide/${button.dataset.slug}.md`), 'Copy as Markdown'); } catch { button.textContent = 'Copy failed'; setTimeout(() => { button.textContent = 'Copy as Markdown'; }, 2000); }
    });
  }
  for (const button of document.querySelectorAll('#copy-all-side')) {
    button.addEventListener('click', async () => {
      button.textContent = 'Copying…';
      try { await copyText(button, await fetchText('/llms-full.txt'), 'Copy docs as Markdown'); } catch { button.textContent = 'Copy failed'; setTimeout(() => { button.textContent = 'Copy docs as Markdown'; }, 2000); }
    });
  }

  // Scroll-spy: the contents list follows the reader, and the address bar
  // keeps the nearest anchor so a copied link lands where they were.
  const links = new Map([...document.querySelectorAll('.docs-sidebar a')].map(link => [link.getAttribute('href').slice(1), link]));
  const headings = [...document.querySelectorAll('.doc-section, .doc-section h2')].map(element => ({ element, id: element.id, section: element.closest('.doc-section')?.id }));
  let ticking = false, lastId = null, initialized = false;
  function spy() {
    ticking = false;
    if (!initialized) return;
    const positions = headings.map(h => ({ ...h, top: h.element.getBoundingClientRect().top + scrollY }));
    const current = currentHeading(positions, scrollY);
    if (!current) return;
    const id = current.id;
    if (id === lastId) return; lastId = id;
    for (const [key, link] of links) {
      const active = key === id || key === current.section;
      if (active) link.setAttribute('aria-current', key === id ? 'location' : 'true'); else link.removeAttribute('aria-current');
    }
    links.get(current.section)?.closest('li')?.classList.add('open');
    for (const li of document.querySelectorAll('.docs-sidebar > nav > ul > li')) if (li.querySelector('a')?.dataset.section !== current.section) li.classList.remove('open');
    // Scroll only the contents pane, never the page (the pane is static on mobile).
    const active = links.get(id), sidebar = document.querySelector('.docs-sidebar');
    if (active && sidebar && sidebar.scrollHeight > sidebar.clientHeight) {
      const bounds = sidebar.getBoundingClientRect(), row = active.getBoundingClientRect();
      if (row.top < bounds.top) sidebar.scrollTop += row.top - bounds.top;
      else if (row.bottom > bounds.bottom) sidebar.scrollTop += row.bottom - bounds.bottom;
    }
    history.replaceState(null, '', `#${id}`);
  }
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });
  function followHash() {
    if (!initialized) return;
    // Native initial fragment scrolling happens after module evaluation. Wait for
    // load before observing/replacing the hash, then align the actual anchor.
    const target = document.getElementById(location.hash.slice(1));
    target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    spy();
  }
  function initialize() { initialized = true; followHash(); }
  addEventListener('resize', spy);
  addEventListener('hashchange', followHash);
  if (document.readyState === 'complete') initialize();
  else addEventListener('load', initialize, { once: true });
}
