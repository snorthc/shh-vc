/** Capability checks. Kept free of the call engine so any screen can use them. */

export interface AudioSupport {
  available: boolean;
  explanation: string;
}

/** Whether this browser can capture a screen at all. Mobile browsers cannot. */
export function screenShareSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
}

function isChromium(): boolean {
  const data = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData;
  if (data?.brands) return data.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge|Brave/i.test(b.brand));
  return /Chrome\//.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);
}

/** An honest account of what audio a share can carry in this browser. */
export function shareAudioSupport(): AudioSupport {
  if (!screenShareSupported()) {
    return { available: false, explanation: 'This browser cannot share a screen.' };
  }
  if (isChromium()) {
    return {
      available: true,
      explanation:
        'A browser tab always offers its audio. A whole screen offers system audio on Windows and ChromeOS only. A single application window never does — browsers do not expose per-application audio. Tick “share audio” in the browser’s picker when it appears.',
    };
  }
  return {
    available: false,
    explanation:
      'This browser cannot capture audio from a shared screen. Your microphone still works alongside the share.',
  };
}

/** Whether this browser can stream a playing video element to the room. */
export function filePlaybackSupported(): boolean {
  if (typeof HTMLMediaElement === 'undefined') return false;
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  return typeof proto.captureStream === 'function' || typeof proto.mozCaptureStream === 'function';
}
