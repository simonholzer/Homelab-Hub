// The login page (only served when HUB_PASSWORD is set). The form is sent by script, as JSON.
import { t, setLanguage } from '/i18n.js';

let lang = 'auto';
try {
  lang = JSON.parse(localStorage.getItem('hub-prefs') ?? '{}').lang ?? 'auto';
} catch {
  // storage blocked: the browser's language
}
setLanguage(lang);

const $ = (id) => document.getElementById(id);
$('label').textContent = t('Password');
$('submit').textContent = t('Log in');
const next = new URLSearchParams(location.search).get('next') ?? '/';

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('error');
  const button = $('submit');
  button.disabled = true;
  error.hidden = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('password').value, next })
    });
    const data = await res.json();
    if (res.ok) return location.replace(data.next ?? '/');
    error.textContent = t(data.error ?? 'Wrong password.');
  } catch {
    error.textContent = t("Can't reach the hub right now.");
  }
  error.hidden = false;
  button.disabled = false;
  $('password').select();
});
