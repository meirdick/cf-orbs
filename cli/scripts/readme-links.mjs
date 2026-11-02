// Used by sync-templates.mjs when it copies the repo README to cli/README.md (the npm page).
export const BLOB = "https://github.com/meirdick/cf-orbs/blob/main/";

/** Rewrites inline markdown links with a relative target to an absolute GitHub URL. Anchors and URLs stay. */
export function absoluteLinks(markdown) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (all, target) =>
    /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target) ? all : `](${BLOB}${target.replace(/^\.\//, "")})`,
  );
}
