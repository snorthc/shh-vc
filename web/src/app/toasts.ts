import { signal } from '@preact/signals';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
}

export const toasts = signal<Toast[]>([]);
let nextId = 1;

export function toast(message: string, kind: ToastKind = 'info', detail?: string, ms = 5000): void {
  const id = nextId++;
  // Collapse repeats so a flapping connection cannot fill the screen.
  if (toasts.value.some((t) => t.message === message)) return;
  toasts.value = [...toasts.value.slice(-3), { id, kind, message, detail }];
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
