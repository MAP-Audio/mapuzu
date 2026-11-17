/*
theme.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// PAM's colours for Strudel's editor, and `pamtheme()`, which puts them on in a REPL that is
// already running. Nothing here imports Strudel or CodeMirror: the REPL keeps its themes in two
// tables that it puts in scope (`themes`, `settings`), and the classes that a theme is made of are
// taken from the editor and from a theme the page already has.

/**
 * PAM's dark theme as a Strudel theme: `settings` are the editor's and the page's colours, and
 * `styles` the syntax, each tag by its `@lezer/highlight` name (`function(variableName)` for a
 * modified one).
 */
export const PAM_THEME = Object.freeze({
  name: 'pam',
  settings: Object.freeze({
    background: '#1b1b1b',
    lineBackground: '#1b1b1b99',
    foreground: '#f2f2f2',
    muted: '#80808099',
    caret: '#70fbbf',
    selection: '#10b98166',
    selectionMatch: '#10b98126',
    lineHighlight: '#28282899',
    gutterBackground: 'transparent',
    gutterForeground: '#636363',
  }),
  styles: Object.freeze([
    { tag: ['string', 'special(string)'], color: '#70fbbf' },
    { tag: ['number', 'unit'], color: '#ffd818' },
    { tag: ['keyword', 'operatorKeyword', 'controlKeyword', 'definitionKeyword', 'moduleKeyword'], color: '#9878e5' },
    { tag: ['atom', 'bool', 'null', 'self'], color: '#b76ec7' },
    { tag: ['labelName', 'special(variableName)'], color: '#10b981' },
    { tag: ['variableName', 'definition(variableName)'], color: '#f2f2f2' },
    { tag: ['function(variableName)', 'propertyName', 'function(propertyName)', 'attributeName'], color: '#6cc1e8' },
    { tag: ['typeName', 'className', 'tagName', 'namespace'], color: '#10b981' },
    { tag: ['operator', 'punctuation', 'separator'], color: '#9e9e9e' },
    { tag: ['bracket', 'paren', 'brace', 'squareBracket'], color: '#808080' },
    { tag: ['comment', 'meta'], color: '#636363' },
    { tag: 'invalid', color: '#f75c5f' },
  ]),
});

// The stock REPL keeps the theme that its settings panel chose under this key.
const CHOSEN_THEME_KEY = 'strudel-settingstheme';
const DEFAULT_THEME = 'strudelTheme';

const flat = (value, out = []) => {
  if (Array.isArray(value)) value.forEach((inner) => flat(inner, out));
  else if (value) out.push(value);
  return out;
};

// The editor's own rules, as Strudel's theme helper writes them.
function editorRules(s) {
  return {
    '&': { color: s.foreground, backgroundColor: s.background },
    '.cm-gutters': { backgroundColor: s.gutterBackground, color: s.gutterForeground },
    '.cm-content': { caretColor: s.caret },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: s.caret },
    '.cm-activeLineGutter': { backgroundColor: s.lineHighlight },
    '.cm-activeLine': { backgroundColor: s.lineHighlight },
    '&.cm-focused .cm-selectionBackground, & .cm-line::selection, & .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': {
      background: `${s.selection} !important`,
    },
    '& .cm-selectionMatch': { backgroundColor: s.selectionMatch },
  };
}

/**
 * A CodeMirror theme extension for `theme`, built from the page's own CodeMirror: the editor's
 * class, and the highlighter, its facet and the syntax tags of the themes already in `themes`.
 * @returns the extension, or undefined where the page keeps its themes some other way
 */
export function themeExtension(theme, { themes, strudelMirror }) {
  const EditorView = strudelMirror?.editor?.constructor;
  const builtIn = Object.values(themes ?? {}).map((extension) => flat(extension));
  const parts = builtIn.find((list) => list.some((part) => Array.isArray(part.value?.specs)));
  if (typeof EditorView?.theme !== 'function' || !EditorView.styleModule || !parts) return undefined;
  const highlighter = parts.find((part) => Array.isArray(part.value?.specs));
  const walker = parts.find((part) => part.inner && 'prec' in part);
  const HighlightStyle = highlighter.value.constructor;
  if (typeof HighlightStyle.define !== 'function' || typeof highlighter.facet?.of !== 'function' || !walker) return undefined;

  const tags = new Map();
  for (const list of builtIn) {
    for (const part of list) {
      for (const spec of part.value?.specs ?? []) {
        for (const tag of flat([spec.tag])) {
          const modifiers = (tag.modified ?? []).map((m) => m.name);
          if (!tag.base) tags.set(tag.name, tag);
          else if (modifiers.length === 1) tags.set(`${modifiers[0]}(${tag.base.name})`, tag);
        }
      }
    }
  }
  const specs = theme.styles
    .map(({ tag, color }) => ({ tag: [tag].flat().map((name) => tags.get(name)).filter(Boolean), color }))
    .filter((spec) => spec.tag.length);
  const style = HighlightStyle.define(specs);
  return [EditorView.theme(editorRules(theme.settings), { dark: true }), [walker, EditorView.styleModule.of(style.module), highlighter.facet.of(style)]];
}

/**
 * @param {{ logger: Function }} core
 * @param {object} [env] where the REPL's `themes`, `settings`, `strudelMirror` and `localStorage` are looked up
 */
export function createTheme({ logger }, env = globalThis) {
  /**
   * Puts PAM's colours on the REPL: the editor, the page around it and what the visualisers draw
   * with. `pamtheme(false)` goes back to the theme chosen in the REPL's settings. It lasts until
   * the page is reloaded, so a song calls it at its top.
   *
   * @name pamtheme
   * @param {boolean} [on] default true
   * @example
   * pamtheme()
   * $: s("1*4")._punchcard().pam()
   */
  function pamtheme(on = true) {
    const { themes, settings, strudelMirror } = env;
    if (!themes || !settings || typeof strudelMirror?.setTheme !== 'function') {
      logger('[pam] no Strudel editor here: pamtheme() is for the REPL', 'warning');
      return false;
    }
    if (on === false || on === 0) {
      let chosen;
      try {
        chosen = env.localStorage?.getItem(CHOSEN_THEME_KEY);
      } catch {
        chosen = undefined;
      }
      if (Object.hasOwn(strudelMirror, 'reconfigureExtension')) delete strudelMirror.reconfigureExtension;
      strudelMirror.setTheme(themes[chosen] ? chosen : DEFAULT_THEME);
      return true;
    }
    if (!themes[PAM_THEME.name]) {
      let extension;
      try {
        extension = themeExtension(PAM_THEME, env);
      } catch {
        extension = undefined;
      }
      // Where the page's CodeMirror is out of reach, the page still takes PAM's colours, and the syntax keeps the default theme's.
      if (!extension) logger('[pam] this REPL keeps its themes another way: PAM colours, the default syntax', 'warning');
      themes[PAM_THEME.name] = extension ?? themes[DEFAULT_THEME];
      settings[PAM_THEME.name] = { ...PAM_THEME.settings };
    }
    // The REPL pushes its stored settings into the editor after each evaluation that changed the
    // code, its own theme among them. So while PAM's theme is on, the editor replaces every theme it
    // is given with PAM's.
    const reconfigure = strudelMirror.reconfigureExtension;
    if (typeof reconfigure === 'function' && !Object.hasOwn(strudelMirror, 'reconfigureExtension')) {
      strudelMirror.reconfigureExtension = function (key, value) {
        return reconfigure.call(this, key, key === 'theme' ? PAM_THEME.name : value);
      };
    }
    strudelMirror.setTheme(PAM_THEME.name);
    return true;
  }

  return { pamtheme };
}
