// Runs before the page is drawn, so a light-theme visitor never sees a dark flash.
// The choice (gear menu) is kept in this browser; "auto" follows the system setting (see style.css).
// A theme of your own (themes: in the YAML) is a built-in one (its base) plus some colors. Its colors
// are kept in this browser too, so it is there from the first frame; app.js updates them.
// window.hubTheme is used by app.js, so the rule lives in one place.
(function () {
  // the built-in themes: a block each in style.css, and the same list in src/config.js (BUILTIN_THEMES)
  var BUILTIN = [
    { id: 'dark', name: 'Dark' },
    { id: 'light', name: 'Light' },
    { id: 'catppuccin', name: 'Catppuccin Mocha' },
    { id: 'nord', name: 'Nord' },
    { id: 'gruvbox', name: 'Gruvbox' },
    { id: 'high-contrast', name: 'High contrast' }
  ];
  var ids = BUILTIN.map(function (t) { return t.id; });
  var applied = []; // the CSS variables a theme of your own has set, removed again on the next change

  /**
   * theme: 'auto', a built-in id, or the id of a theme of your own; custom: that theme
   * ({id, base, colors: {'--accent': '#...'}}) or null.
   */
  function apply(theme, custom) {
    var root = document.documentElement;
    applied.forEach(function (name) { root.style.removeProperty(name); });
    applied = [];
    if (custom && custom.id === theme && ids.indexOf(custom.base) >= 0) {
      root.setAttribute('data-theme', custom.base);
      var colors = custom.colors || {};
      Object.keys(colors).forEach(function (name) {
        // only the page's own color variables (the server checked the values already)
        if (!/^--[a-z-]+$/.test(name) || typeof colors[name] !== 'string') return;
        root.style.setProperty(name, colors[name]);
        applied.push(name);
      });
    } else if (ids.indexOf(theme) >= 0) root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }

  window.hubTheme = { BUILTIN: BUILTIN, apply: apply };

  try {
    var saved = JSON.parse(localStorage.getItem('hub-prefs') || '{}');
    apply(typeof saved.theme === 'string' ? saved.theme : 'auto', saved.customTheme || null);
  } catch (e) {
    // storage blocked: auto
  }
})();
