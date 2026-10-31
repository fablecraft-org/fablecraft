const BETA_NOTICE_DISMISSED_KEY = "fablecraft:beta-notice-dismissed";

export function isBetaNoticeDismissed() {
  return window.localStorage.getItem(BETA_NOTICE_DISMISSED_KEY) === "true";
}

export function rememberBetaNoticeDismissal() {
  window.localStorage.setItem(BETA_NOTICE_DISMISSED_KEY, "true");
}
