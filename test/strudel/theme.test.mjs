/*
theme.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// pamtheme() against a page laid out as strudel.cc lays its themes out: a table of nested
// CodeMirror extensions whose parts carry the classes, a table of settings, and the editor.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PAM_THEME, createTheme } from '../../src/strudel/theme.mjs';
import { pamtheme as packaged } from '../../index.mjs';

function fakePage({ chosen = 'nord' } = {}) {
  const plain = (name) => ({ name, base: null, modified: [] });
  const modified = (modifier, base) => ({ name: base.name, base, modified: [{ name: modifier }] });
  const tags = { string: plain('string'), number: plain('number'), keyword: plain('keyword'), variableName: plain('variableName') };
  tags.call = modified('function', tags.variableName);
  class HighlightStyle {
    static define(specs) {
      return Object.assign(new HighlightStyle(), { specs, module: { made: specs.length } });
    }
  }
  class EditorView {
    static styleModule = { of: (module) => ({ styleModule: module }) };
    static theme(rules, options) {
      return { rules, options };
    }
  }
  const highlighterFacet = { of: (value) => ({ facet: highlighterFacet, value }) };
  const walker = { inner: {}, prec: 'high' };
  const builtIn = HighlightStyle.define([
    { tag: [tags.string, tags.number], color: '#c3e88d' },
    { tag: tags.keyword, color: '#c792ea' },
    { tag: [tags.variableName, tags.call], color: '#82aaff' },
  ]);
  const shown = [];
  const reconfigured = [];
  // As StrudelMirror has them: every way to a theme goes through reconfigureExtension.
  class Mirror {
    editor = new EditorView();
    reconfigureExtension(key, value) {
      if (key === 'theme') shown.push(value);
      else reconfigured.push([key, value]);
    }
    setTheme(name) {
      this.reconfigureExtension('theme', name);
    }
    updateSettings(stored) {
      for (const key of ['theme', 'isLineWrappingEnabled']) this.reconfigureExtension(key, stored[key]);
    }
  }
  return {
    tags,
    walker,
    shown,
    reconfigured,
    themes: { strudelTheme: [{ rules: {} }, [walker, { styleModule: builtIn.module }, highlighterFacet.of(builtIn)]], nord: ['nord'] },
    settings: { strudelTheme: { background: '#222' } },
    strudelMirror: new Mirror(),
    localStorage: { getItem: (key) => (key === 'strudel-settingstheme' ? chosen : null) },
  };
}

const quiet = { logger() {} };

test('pamtheme() makes the theme with the page\'s own CodeMirror and puts it on', () => {
  const page = fakePage();
  const { pamtheme } = createTheme(quiet, page);
  assert.equal(pamtheme(), true);
  assert.deepEqual(page.shown, ['pam']);
  assert.deepEqual(page.settings.pam, PAM_THEME.settings);

  const [editor, [walker, module, highlighter]] = page.themes.pam;
  assert.deepEqual(editor.options, { dark: true });
  assert.deepEqual(editor.rules['&'], { color: '#f2f2f2', backgroundColor: '#1b1b1b' });
  assert.equal(walker, page.walker, 'the page\'s own tree highlighter');
  assert.equal(module.styleModule, highlighter.value.module);
  const colourOf = (tag) => highlighter.value.specs.find((spec) => spec.tag.includes(tag))?.color;
  assert.equal(colourOf(page.tags.string), '#70fbbf');
  assert.equal(colourOf(page.tags.keyword), '#9878e5');
  assert.equal(colourOf(page.tags.variableName), '#f2f2f2');
  assert.equal(colourOf(page.tags.call), '#6cc1e8', 'function(variableName) is its own tag');
  // `unit` is in PAM's theme and not in this page: its spec keeps only the tags the page has.
  assert.deepEqual(highlighter.value.specs.find((spec) => spec.color === '#ffd818').tag, [page.tags.number]);
  assert.ok(highlighter.value.specs.every((spec) => spec.tag.length > 0));
});

test('calling it again puts the same theme on, and pamtheme(false) goes back to the one chosen in the settings', () => {
  const page = fakePage();
  const { pamtheme } = createTheme(quiet, page);
  pamtheme();
  const made = page.themes.pam;
  pamtheme();
  assert.equal(page.themes.pam, made);
  pamtheme(false);
  assert.deepEqual(page.shown, ['pam', 'pam', 'nord']);

  const unknown = fakePage({ chosen: 'a theme this page has not got' });
  createTheme(quiet, unknown).pamtheme(false);
  assert.deepEqual(unknown.shown, ['strudelTheme']);
});

test('the theme holds while the REPL pushes its stored settings back in, until pamtheme(false)', () => {
  const page = fakePage();
  const { pamtheme } = createTheme(quiet, page);
  pamtheme();
  // What strudel.cc does after an evaluation that changed the code.
  page.strudelMirror.updateSettings({ theme: 'nord', isLineWrappingEnabled: true });
  assert.deepEqual(page.shown, ['pam', 'pam']);
  assert.deepEqual(page.reconfigured, [['isLineWrappingEnabled', true]], 'every other setting goes through');
  pamtheme(false);
  page.strudelMirror.updateSettings({ theme: 'nord', isLineWrappingEnabled: false });
  assert.deepEqual(page.shown, ['pam', 'pam', 'nord', 'nord']);
  assert.equal(Object.hasOwn(page.strudelMirror, 'reconfigureExtension'), false);
});

test('a page that keeps its themes another way still takes PAM\'s colours, with the default syntax', () => {
  const page = fakePage();
  page.themes.strudelTheme = ['opaque'];
  const said = [];
  const { pamtheme } = createTheme({ logger: (message, type) => said.push([message, type]) }, page);
  assert.equal(pamtheme(), true);
  assert.equal(page.themes.pam, page.themes.strudelTheme);
  assert.deepEqual(page.settings.pam, PAM_THEME.settings);
  assert.deepEqual(page.shown, ['pam']);
  assert.match(said[0][0], /PAM colours, the default syntax/);
});

test('outside a REPL pamtheme() says so and changes nothing', () => {
  const said = [];
  const { pamtheme } = createTheme({ logger: (message, type) => said.push([message, type]) }, {});
  assert.equal(pamtheme(), false);
  assert.deepEqual(said, [['[pam] no Strudel editor here: pamtheme() is for the REPL', 'warning']]);
  assert.equal(typeof packaged, 'function', 'the package exports it');
});

test('the theme is whole: every setting Strudel reads, every colour a colour', () => {
  assert.deepEqual(Object.keys(PAM_THEME.settings).sort(), [
    'background',
    'caret',
    'foreground',
    'gutterBackground',
    'gutterForeground',
    'lineBackground',
    'lineHighlight',
    'muted',
    'selection',
    'selectionMatch',
  ]);
  const colour = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;
  for (const [key, value] of Object.entries(PAM_THEME.settings)) assert.ok(value === 'transparent' || colour.test(value), key);
  for (const { tag, color } of PAM_THEME.styles) {
    assert.match(color, colour);
    for (const name of [tag].flat()) assert.match(name, /^[a-zA-Z0-9]+(\([a-zA-Z0-9]+\))?$/);
  }
});
