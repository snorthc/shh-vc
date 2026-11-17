import { describeError } from '../app/util.ts';

export class JoinError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function mediaErrorText(err: unknown, device: 'microphone' | 'camera' | 'screen'): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return device === 'screen'
        ? 'Nothing was shared. You closed the picker, or the browser or operating system blocked screen capture.'
        : `Permission was denied. Allow ${device} access for this site in your browser’s address bar, then try again.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${device} was found. Check that one is connected and selected in Settings.`;
    case 'NotReadableError':
    case 'AbortError':
      return `The ${device} is in use by another application, or the system refused to start it.`;
    default:
      return describeError(err);
  }
}
