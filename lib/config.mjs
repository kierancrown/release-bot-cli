import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

const CONFIG_DIR = join(os.homedir(), ".releasebot-cli");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return defaultConfig();
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    // Light normalization
    if (!cfg.repos) cfg.repos = {};
    if (!cfg.tokens) cfg.tokens = {};
    return cfg;
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(cfg) {
  ensureDir(dirname(CONFIG_PATH));
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

export function defaultConfig() {
  return {
    version: 1,
    tokens: {
      githubToken: "",
      openaiApiKey: "",
    },
    repos: {
      // "owner/repo": { lastSinceISO: "", lastTag: "", nextSinceISO: "", lastGeneratedISO: "", lastBranch: "" }
    },
  };
}

export function repoKey(owner, repo) {
  return `${owner}/${repo}`;
}

export function getRepoHistory(cfg, key) {
  if (!cfg.repos[key]) cfg.repos[key] = {};
  return cfg.repos[key];
}

export function setTokens(cfg, { githubToken, openaiApiKey }) {
  if (githubToken !== undefined) cfg.tokens.githubToken = githubToken;
  if (openaiApiKey !== undefined) cfg.tokens.openaiApiKey = openaiApiKey;
}

export function resolveTokens(cfg) {
  // Precedence: env > config file
  return {
    githubToken: process.env.GITHUB_TOKEN || cfg.tokens.githubToken || "",
    openaiApiKey: process.env.OPENAI_API_KEY || cfg.tokens.openaiApiKey || "",
  };
}

export function updateRepoHistoryAfterRun(
  cfg,
  key,
  { resolvedSinceISO, resolvedTag, lastCommitISO, branch },
) {
  const r = getRepoHistory(cfg, key);
  r.lastSinceISO = resolvedSinceISO || r.lastSinceISO || "";
  r.lastTag = resolvedTag || r.lastTag || "";
  r.lastGeneratedISO = new Date().toISOString();
  r.lastBranch = branch || r.lastBranch || "";
  // nextSinceISO = strictly after the last commit we included, to avoid overlap
  // Add +1s to be safe with git’s since semantics
  if (lastCommitISO) {
    const t = new Date(lastCommitISO).getTime();
    r.nextSinceISO = new Date(t + 1000).toISOString();
  }
}
