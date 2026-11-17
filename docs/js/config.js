// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * config.js — the settings menu: API keys and cache retention.
 *
 * Unlike settings.js, which remembers per-browser convenience state in
 * localStorage, everything here belongs to the server: keys are written to
 * .env and retention to cache.conf, the same files an operator edits by hand.
 *
 * Keys travel one way. The server says whether each is set and accepts a
 * replacement, but never sends a stored value, so there is nothing here to
 * show, copy or leak: a field is always empty until something is typed in it.
 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const PATTERNS = {
  duration: /^\d+(\.\d+)?\s*(ms|s|m|h|d|w)?$/i,
  size: /^\d+(\.\d+)?\s*(kb|mb|gb|tb)?$/i,
  count: /^\d+$/,
};

/** Whether the server will accept this text for a cache setting of this kind. */
export function validSetting(kind, value) {
  const re = PATTERNS[kind];
  return !!re && re.test(String(value ?? '').trim());
}

/**
 * What a save should send: only what was changed.
 *
 * `edits.credentials` maps a variable to { value, clear }; an untouched field
 * is left out, so the stored key stays. `edits.cache` maps "section.key" to
 * the text in its field.
 */
export function pending(view, edits) {
  const credentials = {};
  for (const c of view?.credentials || []) {
    const e = edits.credentials?.[c.name];
    if (!e || c.fixed) continue;
    if (e.clear) credentials[c.name] = '';
    else if (typeof e.value === 'string' && e.value.trim()) credentials[c.name] = e.value.trim();
  }
  const cache = {};
  const invalid = [];
  for (const s of view?.cache || []) {
    const typed = edits.cache?.[s.name];
    if (typed == null) continue;
    const v = String(typed).trim();
    if (v === s.value) continue;
    if (validSetting(s.kind, v)) cache[s.name] = v; else invalid.push(s.name);
  }
  return { credentials, cache, invalid };
}

async function call(method, body) {
  const res = await fetch(new URL('/api/settings', location.origin), {
    method,
    cache: 'no-store',
    // X-Panopticon is what every /api call carries; see api() in layers.js.
    headers: { 'X-Panopticon': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.fields = json.fields || null;
    throw err;
  }
  return json;
}

const KIND_HINT = { duration: 'e.g. 30m, 6h, 3d', size: 'e.g. 512MB, 4GB', count: 'a whole number' };

/** Wire the SETTINGS button and its dialog. */
export function installConfigMenu({ toast = () => {} } = {}) {
  const dlg = $('#config');
  const opener = $('#open-config');
  if (!dlg || !opener) return;
  // The static demo has no server to configure.
  if (globalThis.OP_DEMO || typeof dlg.showModal !== 'function') { opener.hidden = true; return; }

  const note = $('#config-note');
  const saveBtn = $('#config-save');
  const reloadBtn = $('#config-reload');
  let view = null;
  let edits = { credentials: {}, cache: {} };

  const say = (msg, bad = false) => {
    note.textContent = msg || '';
    note.classList.toggle('bad', bad);
  };

  const showTab = (name) => {
    for (const t of dlg.querySelectorAll('.cfg-tab')) {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    }
    for (const p of dlg.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
  };

  const group = (title) => {
    const fs = el('fieldset', 'cfg-group');
    fs.append(el('legend', null, title));
    return fs;
  };

  function credentialRow(c) {
    const row = el('div', 'cfg-row');
    row.dataset.name = c.name;
    const id = `cfg-${c.name}`;

    const label = el('label', 'cfg-label', c.label);
    label.htmlFor = id;
    label.append(el('span', 'cfg-var', c.name));

    const state = el('span', 'cfg-state');
    const input = el(c.multiline ? 'textarea' : 'input', 'cfg-input');
    input.id = id;
    if (c.multiline) input.rows = 2;
    else input.type = c.secret ? 'password' : 'text';
    if (c.multiline && c.secret) input.classList.add('masked');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    // Password managers offer to store anything typed in a password field.
    input.setAttribute('data-1p-ignore', '');
    input.setAttribute('data-lpignore', 'true');

    const e = () => (edits.credentials[c.name] ||= { value: '', clear: false });
    const clearBtn = c.set && !c.fixed ? el('button', 'hm-btn cfg-clear', 'Clear') : null;
    if (clearBtn) clearBtn.type = 'button';

    const paint = () => {
      const cur = edits.credentials[c.name];
      const clearing = !!cur?.clear;
      const typed = !clearing && !!cur?.value.trim();
      row.classList.toggle('changed', clearing || typed);
      state.className = `cfg-state ${c.fixed ? 'fixed' : clearing ? 'clearing' : c.set || typed ? 'set' : 'unset'}`;
      state.textContent = c.fixed ? (c.set ? 'Fixed' : 'Fixed, empty')
        : clearing ? 'Will be cleared'
        : typed ? (c.set ? 'Will be replaced' : 'Will be set')
        : c.set ? 'Set' : 'Not set';
      input.disabled = c.fixed || clearing;
      input.placeholder = c.fixed ? 'set outside .env'
        : c.set ? 'stored — type to replace' : c.secret ? 'paste key' : 'not set';
      if (clearBtn) clearBtn.textContent = clearing ? 'Keep' : 'Clear';
    };
    input.addEventListener('input', () => { e().value = input.value; paint(); });
    clearBtn?.addEventListener('click', () => {
      const cur = e();
      cur.clear = !cur.clear;
      if (cur.clear) { cur.value = ''; input.value = ''; }
      paint();
    });
    paint();

    const field = el('div', 'cfg-field');
    field.append(input);
    if (clearBtn) field.append(clearBtn);

    row.append(label, state, field);
    const help = el('p', 'cfg-help');
    if (c.note) help.append(c.note);
    if (c.fixed) {
      help.append(`${c.note ? ' ' : ''}Supplied by the environment the server was started with (Docker or the shell), which overrides ${view.envFile}. Change it there.`);
    }
    if (typeof c.url === 'string' && c.url.startsWith('https://')) {
      const a = el('a', null, 'Get one ↗');
      a.href = c.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      if (help.childNodes.length) help.append(' ');
      help.append(a);
    }
    help.append(el('span', 'cfg-error'));
    row.append(help);
    return row;
  }

  function cacheRow(s) {
    const row = el('div', 'cfg-row');
    row.dataset.name = s.name;
    const id = `cfg-${s.name}`;

    const label = el('label', 'cfg-label', s.key.replace(/_/g, ' '));
    label.htmlFor = id;

    const input = el('input', 'cfg-input short');
    input.id = id;
    input.type = 'text';
    input.value = edits.cache[s.name] ?? s.value;
    input.placeholder = s.default;
    input.title = KIND_HINT[s.kind] || '';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const reset = el('button', 'hm-btn', `Default ${s.default}`);
    reset.type = 'button';
    reset.title = `Set back to the default, ${s.default}`;

    const paint = () => {
      const v = input.value.trim();
      row.classList.toggle('changed', v !== s.value);
      input.classList.toggle('bad', !validSetting(s.kind, v));
      reset.disabled = v === s.default;
    };
    input.addEventListener('input', () => { edits.cache[s.name] = input.value; paint(); });
    reset.addEventListener('click', () => {
      input.value = s.default;
      edits.cache[s.name] = s.default;
      paint();
    });
    paint();

    const field = el('div', 'cfg-field');
    field.append(input, reset);
    const help = el('p', 'cfg-help', s.help);
    help.append(el('span', 'cfg-error'));
    row.append(label, el('span', 'cfg-state'), field, help);
    return row;
  }

  function render() {
    const keys = $('#cfg-keys');
    const cache = $('#cfg-cache');
    keys.replaceChildren();
    cache.replaceChildren();
    if (!view) return;

    keys.append(el('p', 'cfg-intro',
      `Written to ${view.envFile} on the server. A stored key is never sent back to the browser, `
      + 'so set fields show empty: leave one blank to keep what is stored.'));
    const groups = new Map();
    for (const c of view.credentials) {
      if (!groups.has(c.group)) { groups.set(c.group, group(c.group)); keys.append(groups.get(c.group)); }
      groups.get(c.group).append(credentialRow(c));
    }

    cache.append(el('p', 'cfg-intro',
      `Written to ${view.cacheFile} on the server: how long each kind of data is kept before it is `
      + 'fetched again. A number and a unit (90s, 30m, 6h, 3d, 2w); 0 keeps nothing. Sizes take MB or GB.'));
    if (view.cacheProblems?.length) {
      cache.append(el('p', 'cfg-intro bad',
        `${view.cacheFile} has lines the server could not use: ${view.cacheProblems.join('; ')}.`));
    }
    const sections = new Map();
    for (const s of view.cache) {
      if (!sections.has(s.section)) { sections.set(s.section, group(s.section)); cache.append(sections.get(s.section)); }
      sections.get(s.section).append(cacheRow(s));
    }
  }

  function showFieldErrors(fields) {
    for (const span of dlg.querySelectorAll('.cfg-error')) span.textContent = '';
    let first = null;
    for (const [name, why] of Object.entries(fields || {})) {
      const row = [...dlg.querySelectorAll('.cfg-row')].find((r) => r.dataset.name === name);
      if (!row) continue;
      row.querySelector('.cfg-error').textContent = ` ${why}.`;
      first ||= row;
    }
    if (first) {
      showTab(first.closest('[data-pane]').dataset.pane);
      first.querySelector('.cfg-input')?.focus();
    }
  }

  async function open() {
    edits = { credentials: {}, cache: {} };
    reloadBtn.hidden = true;
    say('Loading…');
    showTab('keys');
    if (!dlg.open) dlg.showModal();
    try {
      view = await call('GET');
      render();
      say('');
    } catch (e) {
      view = null;
      render();
      say(`Could not load settings: ${e.message}`, true);
    }
  }

  async function save() {
    if (!view) return;
    const { credentials, cache, invalid } = pending(view, edits);
    if (invalid.length) {
      showFieldErrors(Object.fromEntries(invalid.map((n) => {
        const kind = view.cache.find((s) => s.name === n).kind;
        return [n, `Not a ${kind} (${KIND_HINT[kind]})`];
      })));
      say('Fix the highlighted values first.', true);
      return;
    }
    const nKeys = Object.keys(credentials).length;
    const nCache = Object.keys(cache).length;
    if (!nKeys && !nCache) { say('Nothing has been changed.'); return; }

    saveBtn.disabled = true;
    say('Saving…');
    try {
      const saved = await call('POST', { credentials, cache });
      const files = [nKeys && view.envFile, nCache && view.cacheFile].filter(Boolean).join(' and ');
      view = saved;
      edits = { credentials: {}, cache: {} };
      render();
      say(`Saved to ${files} and in force on the server. Reload the page so it picks up what changed`
        + `${nKeys ? '; if a layer still shows old results, FLUSH drops what was cached without the key.' : '.'}`);
      reloadBtn.hidden = false;
      toast(`Settings saved to ${files}.`);
    } catch (e) {
      showFieldErrors(e.fields);
      say(`Not saved: ${e.message}.`, true);
    } finally {
      saveBtn.disabled = false;
    }
  }

  opener.addEventListener('click', open);
  $('#config-close').addEventListener('click', () => dlg.close());
  $('#config-cancel').addEventListener('click', () => dlg.close());
  reloadBtn.addEventListener('click', () => location.reload());
  for (const t of dlg.querySelectorAll('.cfg-tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
  $('#config-form').addEventListener('submit', (e) => { e.preventDefault(); save(); });
  // Nothing typed outlives the dialog: a key left in a hidden field is a key
  // sitting in the page.
  dlg.addEventListener('close', () => {
    edits = { credentials: {}, cache: {} };
    $('#cfg-keys').replaceChildren();
    $('#cfg-cache').replaceChildren();
  });
}
