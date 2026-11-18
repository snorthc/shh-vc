/** Shared by the call tab and the small link window, which must stay tiny. */
export const LINK_CHANNEL = 'shhvc-link';

export type BridgeStatus =
  | { kind: 'linked'; title: string }
  | { kind: 'busy' }
  | { kind: 'wait' }
  | { kind: 'go'; watch: string; title: string; who: string };
