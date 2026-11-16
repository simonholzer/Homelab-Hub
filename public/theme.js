// Runs before the page is drawn, so a light-theme visitor never sees a dark flash.
// The choice (gear menu) is kept in this browser; "auto" follows the system setting (see style.css).
(function () {
  var theme = 'auto';
  try {
    var saved = JSON.parse(localStorage.getItem('hub-prefs') || '{}').theme;
    if (saved === 'dark' || saved === 'light') theme = saved;
  } catch (e) {
    // storage blocked: auto
  }
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
})();
