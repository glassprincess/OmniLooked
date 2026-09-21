export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'omnilooked:theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStored(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** Applies an explicit user choice if there is one; otherwise the theme follows the system (CSS media query). */
export function initTheme(): void {
  const stored = readStored();
  if (stored) document.documentElement.dataset.theme = stored;
}

export function effectiveTheme(): Theme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'light' || explicit === 'dark') return explicit;
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function toggleTheme(): Theme {
  const next: Theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // storage unavailable: the choice just lasts for this session
  }
  return next;
}

export function watchSystemTheme(callback: () => void): void {
  window.matchMedia(DARK_QUERY).addEventListener('change', callback);
}
