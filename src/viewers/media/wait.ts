/**
 * Resolves on `okEvent`, rejects on 'error' or on abort. With `timeoutMs` it resolves when the time is up
 * (some mobile browsers never fire metadata events until playback starts).
 * Attach it BEFORE setting `src`, so no event can be missed.
 */
export function waitForEvent(
  target: HTMLElement,
  okEvent: string,
  signal: AbortSignal,
  errorMessage: string,
  timeoutMs?: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    let timer = 0;
    const cleanup = (): void => {
      target.removeEventListener(okEvent, onOk);
      target.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      window.clearTimeout(timer);
    };
    const onOk = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(errorMessage));
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    target.addEventListener(okEvent, onOk);
    target.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort);
    if (timeoutMs !== undefined) timer = window.setTimeout(onOk, timeoutMs);
  });
}
