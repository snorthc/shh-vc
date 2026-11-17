import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-preact';
import { dismissToast, toasts } from '../../app/toasts.ts';

const ICONS = { info: Info, success: CircleCheck, warn: TriangleAlert, error: CircleAlert };

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} class={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>
            <Icon />
            <div>
              <div class="toast-title">{t.message}</div>
              {t.detail && <div class="toast-detail">{t.detail}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
