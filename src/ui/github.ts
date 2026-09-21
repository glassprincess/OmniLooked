import { t } from '../i18n';
import { h } from './dom';
import { icon } from './icons';

/** Author identity shown under the dropzone. Change once, used everywhere. */
export const GITHUB_USER = 'glassprincess';
export const GITHUB_REPO = 'omnilooked';
const AVATAR_URL = 'https://avatars.githubusercontent.com/u/192819416?v=4';

function httpsUrl(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('https://') ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function compactCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value >= 1000) {
    const thousands = value / 1000;
    const rounded = thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
    return `${rounded}k`;
  }
  return String(Math.floor(value));
}

/**
 * Author card under the dropzone. The skeleton (avatar, handle, repo link)
 * renders instantly from constants; names and stars fill in live from the
 * GitHub API. Offline or unknown repo: the static card simply stays.
 */
export function mountGithubCard(host: HTMLElement): void {
  const repoUrl = `https://github.com/${GITHUB_USER}/${GITHUB_REPO}`;
  const avatar = h('img', { class: 'gh-avatar', alt: '', src: AVATAR_URL, loading: 'lazy' });
  avatar.addEventListener('error', () => avatar.remove());
  const name = h('div', { class: 'gh-name' }, t('ghName'));
  const handle = h(
    'a',
    { class: 'gh-handle', href: `https://github.com/${GITHUB_USER}`, target: '_blank', rel: 'noopener noreferrer' },
    `@${GITHUB_USER}`,
  );
  const repo = h(
    'a',
    { class: 'gh-repo', href: repoUrl, target: '_blank', rel: 'noopener noreferrer' },
    `${GITHUB_USER}/${GITHUB_REPO}`,
  );
  const starCount = h('span', { class: 'gh-stars-count' }, '…');
  const stars = h(
    'span',
    { class: 'gh-stars', title: t('ghStarsLabel'), 'aria-label': t('ghStarsLabel'), hidden: true },
    icon('star'),
    starCount,
  );
  const open = h(
    'a',
    { class: 'btn small gh-open', href: repoUrl, target: '_blank', rel: 'noopener noreferrer' },
    icon('github', true),
    h('span', { class: 'label' }, t('ghOpen')),
  );
  host.append(
    h(
      'div',
      { class: 'github-card' },
      avatar,
      h('div', { class: 'gh-id' }, name, handle),
      h('div', { class: 'gh-side' }, repo, h('div', { class: 'gh-actions' }, stars, open)),
    ),
  );
  void refreshLiveData(avatar, name, handle, repo, open, stars, starCount, repoUrl);
}

async function refreshLiveData(
  avatar: HTMLImageElement,
  name: HTMLElement,
  handle: HTMLAnchorElement,
  repo: HTMLAnchorElement,
  open: HTMLAnchorElement,
  stars: HTMLElement,
  starCount: HTMLElement,
  repoUrl: string,
): Promise<void> {
  const [userRaw, repoRaw] = await Promise.all([
    fetchJson(`https://api.github.com/users/${GITHUB_USER}`),
    fetchJson(`https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}`),
  ]);
  const user = asRecord(userRaw);
  if (user) {
    const avatarUrl = httpsUrl(user['avatar_url']);
    if (avatarUrl && avatar.isConnected) avatar.src = avatarUrl;
    if (typeof user['name'] === 'string' && user['name'].trim() !== '' && name.isConnected) {
      name.textContent = user['name'].trim();
    }
    const profileUrl = httpsUrl(user['html_url']);
    if (profileUrl && handle.isConnected) handle.href = profileUrl;
  }
  const info = asRecord(repoRaw);
  if (!info) return;
  const htmlUrl = httpsUrl(info['html_url']) ?? repoUrl;
  if (repo.isConnected) {
    repo.href = htmlUrl;
    repo.textContent = `${GITHUB_USER}/${GITHUB_REPO}`;
  }
  if (open.isConnected) open.href = htmlUrl;
  if (typeof info['stargazers_count'] === 'number' && stars.isConnected) {
    starCount.textContent = compactCount(info['stargazers_count']);
    stars.hidden = false;
  }
}
