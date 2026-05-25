// src/shared/scrollProfile.ts

export type ScrollProfileName = 'default' | 'fast' | 'turbo';

export interface ScrollProfile {
  name: ScrollProfileName;
  label: string;

  // AutoCollector
  acScrollStepRatio: number;
  acSettleStableMs: number;
  acSettleQuietMs: number;
  acSettlePollMs: number;

  // JumpController
  jcSettleMs: number;
  jcDecayRate: number;
  jcMinDecay: number;
}

export const SCROLL_PROFILES: Record<ScrollProfileName, ScrollProfile> = {
  default: {
    name: 'default',
    label: '标准',
    acScrollStepRatio: 0.7,
    acSettleStableMs: 500,
    acSettleQuietMs: 400,
    acSettlePollMs: 100,
    jcSettleMs: 500,
    jcDecayRate: 0.03,
    jcMinDecay: 0.3,
  },
  fast: {
    name: 'fast',
    label: '快速',
    acScrollStepRatio: 0.85,
    acSettleStableMs: 300,
    acSettleQuietMs: 250,
    acSettlePollMs: 80,
    jcSettleMs: 300,
    jcDecayRate: 0.02,
    jcMinDecay: 0.4,
  },
  turbo: {
    name: 'turbo',
    label: '极速',
    acScrollStepRatio: 1.0,
    acSettleStableMs: 200,
    acSettleQuietMs: 150,
    acSettlePollMs: 50,
    jcSettleMs: 200,
    jcDecayRate: 0.01,
    jcMinDecay: 0.5,
  },
};

export function getScrollProfile(name: ScrollProfileName): ScrollProfile {
  return SCROLL_PROFILES[name];
}

export const SCROLL_PROFILE_ORDER: ScrollProfileName[] = ['default', 'fast', 'turbo'];

export const PROFILE_STORAGE_KEY = 'cqn-scroll-profile';

/** AutoCollector settle 超时 — 不纳入 profile 管理，始终固定 5 秒 */
export const AC_SETTLE_TIMEOUT_MS = 5000;
