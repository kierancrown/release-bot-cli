#!/usr/bin/env node
import { Command } from "commander";
import enquirer from "enquirer";
const { prompt } = enquirer;
import simpleGit from "simple-git";
import { Octokit } from "@octokit/rest";
import OpenAI from "openai";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  saveConfig,
  defaultConfig,
  repoKey,
  getRepoHistory,
  setTokens,
  resolveTokens,
  updateRepoHistoryAfterRun,
} from "../lib/config.mjs";

/** -------- Utils -------- */

function parseGitHubRemote(url) {
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/(.+?)(\.git)?$/);
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(\.git)?$/);
  const m = sshMatch || httpsMatch;
  if (!m) return null;
  const host = m[1];
  const owner = m[2];
  const repo = m[3].replace(/\.git$/, "");
  const webBase = `https://${host}/${owner}/${repo}`;
  return { host, owner, repo, webBase };
}

function extractPRs(message) {
  const prs = new Set();
  const patterns = [
    /Merge pull request\s+#(\d+)/gi,
    /\(#(\d+)\)/g,
    /PR\s+#(\d+)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(message))) prs.add(Number(m[1]));
  }
  return [...prs];
}

async function getCommitsSince(git, branch, since) {
  await git.fetch();
  await git.checkout(branch);
  await git.pull("origin", branch);
  const log = await git.log({
    to: `origin/${branch}`,
    symmetric: false,
    "--since": since,
  });
  return log.all;
}

function buildCommitUrl(webBase, sha) {
  return `${webBase}/commit/${sha}`;
}

function uniqueCommits(commits) {
  const seen = new Set();
  return commits.filter((c) =>
    seen.has(c.hash) ? false : (seen.add(c.hash), true),
  );
}

async function fetchPRsDetails(octokit, owner, repo, prNumbers) {
  const results = {};
  const batch = 8;
  for (let i = 0; i < prNumbers.length; i += batch) {
    const slice = prNumbers.slice(i, i + batch);
    await Promise.all(
      slice.map(async (number) => {
        try {
          const { data } = await octokit.pulls.get({
            owner,
            repo,
            pull_number: number,
          });
          results[number] = {
            number,
            title: data.title,
            url: data.html_url,
            merged_at: data.merged_at,
            author: data.user?.login,
          };
        } catch {}
      }),
    );
  }
  return results;
}

function buildFullChangelog(commits, prMap, webBase) {
  return commits
    .map((c) => {
      const prs = extractPRs(c.message);
      const firstPr = prs[0] && prMap[prs[0]] ? prMap[prs[0]] : null;
      const commitUrl = buildCommitUrl(webBase, c.hash);
      const shortSha = c.hash.slice(0, 7);

      if (firstPr) {
        return `- [**${firstPr.title} (](${commitUrl})[#${firstPr.number}](${firstPr.url})[)](${commitUrl})**`;
      } else {
        const firstLine = c.message.split("\n")[0];
        return `- [**${firstLine} (${shortSha})**](${commitUrl})`;
      }
    })
    .join("\n");
}

async function generateNarrativeSections(openai, prItemsMarkdown) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You write concise, product-facing release notes in Markdown only.",
      },
      {
        role: "user",
        content: `We have this list of changes (as Markdown bullets):

${prItemsMarkdown}

Create the following sections, each concise and plain (no emojis), even if "None":
- ## Major features:
- ## Risks:
- ## Impacts:
- ## Disabled feature flags:
- ## Known issues:
- ## Out of scope:
- ## Other notes:

Rules:
- Keep bullets short (~120 chars).
- If unsure, use "None".
- Do not invent specifics not implied by titles.`,
      },
    ],
  });
  return completion.choices[0]?.message?.content?.trim() ?? "";
}

/** -------- First-run helper -------- */

async function ensureSetupInteractive(cfg) {
  const tokens = resolveTokens(cfg);
  const missingGitHub = !tokens.githubToken;
  // OpenAI is optional; still offer prompt if missing.

  if (missingGitHub || !tokens.openaiApiKey) {
    const answers = await prompt([
      ...(missingGitHub
        ? [
            {
              type: "password",
              name: "githubToken",
              message: "Enter your GitHub token (repo:read recommended):",
            },
          ]
        : []),
      {
        type: "password",
        name: "openaiApiKey",
        message: "Enter your OpenAI API key (optional, press Enter to skip):",
        initial: tokens.openaiApiKey || "",
      },
    ]);
    setTokens(cfg, {
      githubToken: answers.githubToken ?? tokens.githubToken,
      openaiApiKey: answers.openaiApiKey ?? tokens.openaiApiKey,
    });
    saveConfig(cfg);
  }
  // Return final tokens after potential update
  return resolveTokens(cfg);
}

/** -------- CLI -------- */

async function runGenerate(opts) {
  const cfg = loadConfig();

  // Resolve repo
  const git = simpleGit();
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    console.error("Not a git repository.");
    process.exit(1);
  }
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin") || remotes[0];
  if (!origin) {
    console.error("No git remote found.");
    process.exit(1);
  }
  const gh = parseGitHubRemote(origin.refs.fetch);
  if (!gh || gh.host !== "github.com") {
    console.error("This tool currently supports GitHub remotes only.");
    process.exit(1);
  }
  const repoId = repoKey(gh.owner, gh.repo);
  const history = getRepoHistory(cfg, repoId);

  // First-run: prompt tokens, then resolve
  const tokens = await ensureSetupInteractive(cfg);

  // Branch
  const branch = opts.branch || history.lastBranch || "main";

  // Determine 'since'
  let since = opts.since;
  let usedTag = "";
  if (opts.tag) {
    const tagDate = execSync(`git log -1 --format=%aI ${opts.tag}`, {
      encoding: "utf8",
    }).trim();
    if (!tagDate) {
      console.error(`Could not find date for tag ${opts.tag}`);
      process.exit(1);
    }
    since = tagDate;
    usedTag = opts.tag;
  }

  // History default if no explicit since
  if (!since && !opts.tag && history.nextSinceISO && !opts.ignoreHistory) {
    since = history.nextSinceISO;
  }

  // If still missing, ask user
  if (!since) {
    const answer = await prompt({
      type: "input",
      name: "since",
      message: "Generate changelog since (ISO date or '2 weeks ago'):",
      initial: history.lastSinceISO || "2 weeks ago",
    });
    since = answer.since;
  }

  // Fetch commits
  const commits = uniqueCommits(await getCommitsSince(git, branch, since));
  // Track max commit timestamp we included
  let lastCommitISO = "";
  if (commits.length) {
    const max = commits.reduce((a, b) => (a.date > b.date ? a : b));
    lastCommitISO = max.date;
  }

  // PRs
  const prNumbers = [...new Set(commits.flatMap((c) => extractPRs(c.message)))];

  // GitHub client (from env or config)
  const octokit = tokens.githubToken
    ? new Octokit({ auth: tokens.githubToken })
    : null;
  let prMap = {};
  if (octokit && prNumbers.length) {
    prMap = await fetchPRsDetails(octokit, gh.owner, gh.repo, prNumbers);
  }

  // Full changelog list
  const fullChangelogMd = buildFullChangelog(commits, prMap, gh.webBase);

  // Narrative via OpenAI unless --no-ai
  let narrative = "";
  const wantAI = opts.ai !== false;
  if (wantAI && tokens.openaiApiKey) {
    const openai = new OpenAI({ apiKey: tokens.openaiApiKey });
    narrative = await generateNarrativeSections(openai, fullChangelogMd);
  } else {
    narrative = `## Major features:
- None

## Risks:
- None

## Impacts:
- None

## Disabled feature flags:
- None

## Known issues:
- None

## Out of scope:
- None

## Other notes:
- None`;
  }

  // Output
  const buildVersion = opts.build || "";
  const header = `## Build version:\n\n${buildVersion || "*<add version>*"}\n`;
  const section = `## Full Changelog\n\n${fullChangelogMd}\n\n${narrative}\n`;
  const output = `${header}\n${section}`.trim() + "\n";

  const outFile = join(
    process.cwd(),
    `CHANGELOG_${new Date().toISOString().slice(0, 10)}.md`,
  );
  writeFileSync(outFile, output, "utf8");
  process.stdout.write(output);
  process.stderr.write(`\nSaved: ${outFile}\n`);

  // Update history (unless --no-history)
  if (!opts.noHistory) {
    updateRepoHistoryAfterRun(cfg, repoId, {
      resolvedSinceISO: usedTag
        ? ""
        : opts.since
          ? new Date(opts.since).toISOString?.() || ""
          : history.lastSinceISO || "",
      resolvedTag: usedTag || "",
      lastCommitISO,
      branch,
    });
    // If user wants to override nextSince, respect it
    if (opts.setNextSince) {
      cfg.repos[repoId].nextSinceISO = new Date(
        opts.setNextSince,
      ).toISOString();
    }
    saveConfig(cfg);
  }
}

async function runConfig({ resetKeys }) {
  const cfg = loadConfig();
  const tokens = resolveTokens(cfg);

  const answers = await prompt([
    ...(resetKeys
      ? [
          {
            type: "password",
            name: "githubToken",
            message: "GitHub token (repo:read):",
            initial: "",
          },
        ]
      : [
          {
            type: "password",
            name: "githubToken",
            message: "GitHub token (repo:read):",
            initial: tokens.githubToken || "",
          },
        ]),
    {
      type: "password",
      name: "openaiApiKey",
      message: "OpenAI API key (optional):",
      initial: resetKeys ? "" : tokens.openaiApiKey || "",
    },
  ]);
  setTokens(cfg, {
    githubToken: answers.githubToken,
    openaiApiKey: answers.openaiApiKey,
  });
  saveConfig(cfg);
  console.log("Config saved at ~/.releasebot-cli/config.json");
}

/** -------- Program -------- */

const program = new Command();

program
  .name("releasebot")
  .description("Generate Notion-ready release notes from Git history/PRs.")
  .version("0.2.0");

program
  .command("config")
  .description("Configure tokens and options")
  .option(
    "--reset-keys",
    "Reset tokens instead of editing existing ones",
    false,
  )
  .action((opts) => runConfig(opts));

program
  .command("reset-keys")
  .description("Shortcut: clear & re-enter tokens")
  .action(() => runConfig({ resetKeys: true }));

program
  .option(
    "--since <date>",
    "ISO date or git-parsable date (e.g., 2025-09-01, '2 weeks ago')",
  )
  .option("--tag <tag>", "Generate notes since a git tag (uses tag's date)")
  .option("--build <buildVersion>", "Build version string for the header")
  .option("--no-ai", "Skip OpenAI narrative generation")
  .option("--branch <branch>", "Branch to generate from (default: main)")
  .option("--ignore-history", "Ignore stored nextSince; prompt or use flags")
  .option("--no-history", "Do not save/advance history after this run")
  .option(
    "--set-next-since <date>",
    "Manually set the nextSince to use on the following run",
  )
  .action((opts) => runGenerate(opts));

program.parse(process.argv);
