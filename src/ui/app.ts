import { Dispatcher, type LoadStage, type ViewerFailure, type ViewerSession } from '../core/dispatcher';
import { formatBytes } from '../core/format';
import { getExtension } from '../core/sniffer';
import { language, t } from '../i18n';
import { OPEN_NESTED_EVENT } from '../types';
import { h } from './dom';
import { mountGithubCard } from './github';
import { icon, type IconName } from './icons';
import { effectiveTheme, toggleTheme, watchSystemTheme } from './theme';

type State = 'empty' | 'loading' | 'viewer' | 'error';

/** Stage bar: a step indicator (quarters), not a byte counter. */
const STAGE_PROGRESS: Record<LoadStage, number> = { reading: 25, loading: 50, rendering: 75 };

function setButton(button: HTMLButtonElement, iconName: IconName, label: string): void {
  button.replaceChildren(icon(iconName), h('span', { class: 'label' }, label));
  button.title = label;
  button.setAttribute('aria-label', label);
}

function describeType(file: File): string {
  return file.type || getExtension(file.name).toUpperCase() || '—';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mountApp(root: HTMLElement): void {
  document.documentElement.lang = language;
  const canFullscreen = document.fullscreenEnabled === true;
  let currentFile: File | null = null;
  const parents: File[] = [];
  let modeAction: (() => void) | null = null;

  // ---- toolbar -------------------------------------------------------------------------------------------------
  const brand = h('div', { class: 'brand' }, 'OmniLooked');
  const backButton = h('button', { class: 'btn', type: 'button', hidden: true });
  setButton(backButton, 'back', t('back'));
  const fileName = h('div', { class: 'file-name' });
  const fileSize = h('span');
  const fileType = h('span');
  const fileInfo = h('div', { class: 'file-info', hidden: true }, fileName, h('div', { class: 'file-meta' }, fileSize, fileType));

  const modeButton = h('button', { class: 'btn', type: 'button', hidden: true });
  const themeButton = h('button', { class: 'btn', type: 'button' });
  const fullscreenButton = h('button', { class: 'btn', type: 'button', hidden: true });
  const closeButton = h('button', { class: 'btn', type: 'button', hidden: true });
  setButton(closeButton, 'close', t('close'));

  const toolbar = h(
    'header',
    { class: 'toolbar' },
    backButton,
    brand,
    fileInfo,
    h('div', { class: 'spacer' }),
    modeButton,
    themeButton,
    fullscreenButton,
    closeButton,
  );

  // ---- states --------------------------------------------------------------------------------------------------
  const input = h('input', { type: 'file', hidden: true });
  const chooseButton = h('button', { class: 'btn primary btn-xl', type: 'button' }, t('chooseFile'));
  const formats = [
    'PNG', 'JPG', 'GIF', 'SVG', 'WEBP', 'MP4', 'MP3', 'MD', 'PDF',
    'DOCX', 'XLSX', 'PPTX', 'DOC', 'XLS', 'ODS', 'ODP', 'ZIP',
    'HTML', 'JSON', 'CSV', 'TXT',
  ];
  const chips = h(
    'div',
    { class: 'format-chips' },
    h('span', { class: 'formats-label' }, t('formatsLabel')),
    ...formats.map((format) => h('span', { class: 'chip' }, format)),
  );
  const githubHost = h('div', { class: 'github-host' });
  mountGithubCard(githubHost);
  const empty = h(
    'section',
    { class: 'state empty' },
    h(
      'div',
      { class: 'hero' },
      h('div', { class: 'hero-eyebrow' }, h('span', { class: 'pulse-dot' }), h('span', {}, t('heroEyebrow'))),
      h('h1', { class: 'hero-title' }, t('heroTitleA'), ' ', h('span', { class: 'grad' }, t('heroTitleB'))),
      h('p', { class: 'hero-sub' }, t('heroSub')),
      h(
        'div',
        { class: 'dropzone' },
        h('div', { class: 'dz-icon' }, icon('upload')),
        h('div', { class: 'dz-title' }, t('dropTitle')),
        h('div', { class: 'dz-or' }, t('dropOr')),
        chooseButton,
        input,
      ),
      chips,
      h('p', { class: 'privacy' }, t('privacyNote')),
      githubHost,
    ),
  );

  const stageText = h('div', { class: 'stage-text', role: 'status' });
  const barFill = h('div', { class: 'bar-fill' });
  const loading = h('section', { class: 'state loading' }, h('div', { class: 'loading-box' }, stageText, h('div', { class: 'bar' }, barFill)));

  const errorDetail = h('code', { class: 'error-detail' });
  const fallbackButton = h('button', { class: 'btn primary', type: 'button' }, t('openAsTextHex'));
  const errorClose = h('button', { class: 'btn', type: 'button' }, t('close'));
  const error = h(
    'section',
    { class: 'state error' },
    h(
      'div',
      { class: 'error-box', role: 'alert' },
      h('h2', {}, t('errorTitle')),
      h('p', {}, t('errorBody')),
      errorDetail,
      h('div', { class: 'error-actions' }, fallbackButton, errorClose),
    ),
  );

  const viewer = h('div', { class: 'viewer' });
  const stage = h('main', { class: 'stage' }, viewer, empty, loading, error);
  const dropOverlay = h('div', { class: 'drop-overlay', hidden: true }, h('div', {}, t('dropRelease')));
  const app = h('div', { class: 'app', 'data-state': 'empty' }, toolbar, stage, dropOverlay);
  root.replaceChildren(app);

  function setState(state: State): void {
    app.dataset.state = state;
    fileInfo.hidden = state === 'empty';
    closeButton.hidden = state === 'empty';
    fullscreenButton.hidden = !(state === 'viewer' && canFullscreen);
    if (state !== 'viewer') modeButton.hidden = true;
  }

  // ---- viewer lifecycle ----------------------------------------------------------------------------------------
  const dispatcher = new Dispatcher(viewer, {
    onStage(stageName, moduleName) {
      setState('loading');
      barFill.style.width = `${STAGE_PROGRESS[stageName]}%`;
      if (stageName === 'reading') stageText.textContent = t('stageReading');
      else if (stageName === 'loading') stageText.textContent = t('stageLoading', { name: moduleName ?? '' });
      else stageText.textContent = t('stageRendering');
    },
    onReady(session: ViewerSession) {
      setState('viewer');
      if (session.forcedFallback) {
        setButton(modeButton, 'eye', t('normalView'));
        modeAction = () => open(session.file, false);
        modeButton.hidden = false;
      } else if (session.plugin.id !== 'fallback') {
        setButton(modeButton, 'code', t('openAsTextHex'));
        modeAction = () => open(session.file, true);
        modeButton.hidden = false;
      } else {
        modeAction = null;
      }
    },
    onError(failure: ViewerFailure) {
      setState('error');
      errorDetail.textContent = errorText(failure.error);
      fallbackButton.hidden = !failure.canOpenFallback;
    },
  });

  function open(file: File, forceFallback = false): void {
    currentFile = file;
    fileName.textContent = file.name;
    fileName.title = file.name;
    fileSize.textContent = formatBytes(file.size);
    fileType.textContent = describeType(file);
    refreshBack();
    void dispatcher.open(file, { forceFallback });
  }

  function goBack(): void {
    const previous = parents.pop();
    refreshBack();
    if (previous) open(previous);
  }

  function refreshBack(): void {
    backButton.hidden = parents.length === 0;
  }

  function close(): void {
    dispatcher.close();
    currentFile = null;
    modeAction = null;
    parents.length = 0;
    refreshBack();
    if (document.fullscreenElement) void document.exitFullscreen();
    setState('empty');
  }

  // ---- controls ------------------------------------------------------------------------------------------------
  chooseButton.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = ''; // lets the same file be chosen again
    if (file) open(file);
  });

  modeButton.addEventListener('click', () => modeAction?.());
  backButton.addEventListener('click', goBack);
  window.addEventListener(OPEN_NESTED_EVENT, (event: Event) => {
    const nested = (event as CustomEvent<File>).detail;
    if (!(nested instanceof File)) return;
    if (currentFile) parents.push(currentFile);
    open(nested);
  });
  fallbackButton.addEventListener('click', () => {
    if (currentFile) open(currentFile, true);
  });
  errorClose.addEventListener('click', close);
  closeButton.addEventListener('click', close);

  const refreshTheme = (): void => {
    const dark = effectiveTheme() === 'dark';
    setButton(themeButton, dark ? 'sun' : 'moon', dark ? t('themeToLight') : t('themeToDark'));
  };
  themeButton.addEventListener('click', () => {
    toggleTheme();
    refreshTheme();
  });
  watchSystemTheme(refreshTheme);
  refreshTheme();

  const refreshFullscreen = (): void => {
    const active = document.fullscreenElement !== null;
    setButton(fullscreenButton, active ? 'exitFullscreen' : 'fullscreen', active ? t('exitFullscreen') : t('fullscreen'));
  };
  fullscreenButton.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.requestFullscreen().catch(() => undefined);
  });
  document.addEventListener('fullscreenchange', refreshFullscreen);
  refreshFullscreen();

  // ---- drag and drop over the whole window ---------------------------------------------------------------------
  let dragDepth = 0;
  const carriesFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files');

  document.addEventListener('dragenter', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
  });
  document.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  });
  document.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    const file = event.dataTransfer?.files[0];
    if (file) open(file);
  });

  setState('empty');
}
