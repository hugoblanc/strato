/**
 * What a build of Strato is: its version (scripts/package.json, embedded at build time) and the name of the release
 * asset of a platform. Pure: the platform is a parameter.
 */
import pkg from "../package.json" with { type: "json" };

/** The version of this code: `version` in scripts/package.json. A release is tagged `v<version>`. */
export const STRATO_VERSION: string = pkg.version;

/** The GitHub repository releases are published to. */
export const RELEASE_REPO = "hugoblanc/strato";

/** Platforms a release ships a binary for, as `<os>-<arch>`. */
export const RELEASE_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

/** `process.platform`/`process.arch` -> the release's `<os>-<arch>`, or null for a platform without a binary. */
export function releaseTarget(platform: string = process.platform, arch: string = process.arch): ReleaseTarget | null {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" || arch === "arm64" ? arch : null;
  const t = `${os}-${cpu}`;
  return (RELEASE_TARGETS as readonly string[]).includes(t) ? (t as ReleaseTarget) : null;
}

/** The asset name of a target: `strato-darwin-arm64`, `strato-windows-x64.exe`. */
export const assetName = (t: ReleaseTarget) => `strato-${t}${t.startsWith("windows") ? ".exe" : ""}`;
