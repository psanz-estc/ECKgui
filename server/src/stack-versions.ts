import { compareVersions } from "./eck.js";

export const DEFAULT_STACK_VERSION = "9.5.0";

const GA_VERSION_RE = /^\d+\.\d+\.\d+$/;
const FALLBACK_STACK_VERSIONS = [
  "9.5.2",
  "9.5.1",
  "9.5.0",
  "9.4.5",
  "8.19.20",
  "8.18.8",
];

export type StackVersionList = {
  defaultVersion: string;
  versions: string[];
  source: "artifacts" | "github" | "fallback";
};

function isGaVersion(version: string): boolean {
  return GA_VERSION_RE.test(version);
}

function sortNewestFirst(versions: string[]): string[] {
  return [...new Set(versions)].sort((a, b) => compareVersions(b, a));
}

function pickDefault(versions: string[]): string {
  const nine = versions.find((v) => v.startsWith("9."));
  return nine || versions[0] || DEFAULT_STACK_VERSION;
}

function asList(
  versions: string[],
  source: StackVersionList["source"],
): StackVersionList {
  const sorted = sortNewestFirst(versions.filter(isGaVersion));
  if (sorted.length === 0) {
    return {
      defaultVersion: DEFAULT_STACK_VERSION,
      versions: FALLBACK_STACK_VERSIONS,
      source: "fallback",
    };
  }
  return {
    defaultVersion: pickDefault(sorted),
    versions: sorted,
    source,
  };
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ECKgui",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} (${res.status} ${res.statusText})`);
  }
  return await res.json();
}

async function fromArtifactsApi(): Promise<string[]> {
  const parsed = (await fetchJson(
    "https://artifacts-api.elastic.co/v1/versions",
    8_000,
  )) as { versions?: unknown };
  const versions = Array.isArray(parsed.versions) ? parsed.versions : [];
  return versions.filter((v): v is string => typeof v === "string");
}

async function fromGithubReleases(): Promise<string[]> {
  const parsed = (await fetchJson(
    "https://api.github.com/repos/elastic/elasticsearch/releases?per_page=40",
    8_000,
  )) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean }>;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((r) => r && !r.draft && !r.prerelease && r.tag_name)
    .map((r) => r.tag_name!.replace(/^v/i, ""));
}

export async function listElasticStackVersions(): Promise<StackVersionList> {
  try {
    const versions = await fromArtifactsApi();
    const list = asList(versions, "artifacts");
    if (list.source === "artifacts") return list;
  } catch {
    // try GitHub next
  }

  try {
    const versions = await fromGithubReleases();
    const list = asList(versions, "github");
    if (list.source === "github") return list;
  } catch {
    // fall through
  }

  return {
    defaultVersion: DEFAULT_STACK_VERSION,
    versions: FALLBACK_STACK_VERSIONS,
    source: "fallback",
  };
}
