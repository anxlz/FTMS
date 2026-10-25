import { languageFor, MESSAGES, reachable, START_PATH, webUrlFrom } from './launch.js';

const lang = languageFor(navigator.languages ?? [navigator.language]);
const text = MESSAGES[lang];
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
document.title = text.title;
document.getElementById('title').textContent = text.title;

const status = document.getElementById('status');
const retry = document.getElementById('retry');
retry.textContent = text.retry;

function show(message, canRetry) {
  status.textContent = message;
  retry.hidden = !canRetry;
}

async function start() {
  show(text.connecting, false);
  let config = null;
  try {
    config = await (await fetch('config.json', { cache: 'no-store' })).json();
  } catch {
    config = null;
  }
  const origin = webUrlFrom(config);
  if (!origin) return show(text.notConfigured, false);
  if (!navigator.onLine) return show(text.offline, true);
  if (!(await reachable(origin, fetch))) return show(text.unreachable, true);
  // Replace the launcher: Android's back button then never returns to it. Signed in,
  // the start screen forwards to the user's home page.
  location.replace(`${origin}${START_PATH}`);
}

retry.addEventListener('click', () => void start());
window.addEventListener('online', () => void start());
void start();
