// stands in for src/lib/router.js in the svg build. same exports, but the page
// lives in the hash (index.svg#/games) because a cdn has no fallback to index.
import { signal } from "@preact/signals";

const current = () => location.hash.slice(1).split("?")[0] || "/";

export const route = signal(current());

export function navigate(path, { replace = false } = {}) {
  if (path === location.hash.slice(1)) return;
  // the shim turns these into #/path
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  route.value = current();
  window.scrollTo({ top: 0 });
}

const sync = () => {
  route.value = current();
};
window.addEventListener("popstate", sync);
window.addEventListener("hashchange", sync);

/** "/movies/tv/1399" -> ["movies", "tv", "1399"] */
export function segments(path = route.value) {
  return path.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

export function section(path = route.value) {
  return segments(path)[0] || "home";
}
