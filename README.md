# 🤖 release-bot-cli

A simple Node.js CLI to generate **Notion-ready changelogs** from GitHub PRs and commits.
It can also call OpenAI to produce clean narrative sections (Major features, Risks, etc.).

---

## Features

- 🚀 Generate a Markdown changelog for past commits/PRs
- 📝 Notion-ready formatting
- 🔐 First run prompts for `GITHUB_TOKEN` (required) and `OPENAI_API_KEY` (optional)
- 💾 Saves config in `~/.releasebot-cli/config.json`
- ⏱️ Stores last "since" and next "since" dates to avoid overlapping logs
- 🛠️ Works with squash or merge commits containing `(#123)` or `Merge pull request #123`

---

## Installation (local, for yourself)

Clone this repo somewhere on your machine:

```bash
git clone https://github.com/kierancrown/release-bot-cli.git
cd release-bot-cli
```

Install dependencies:

```bash
npm install
```

Link the CLI locally (makes `releasebot` available on your PATH):

```bash
npm link
```

Now you can run `releasebot` from any repo on your machine.
(To remove: `npm unlink -g release-bot-cli`)

If you don’t want to link globally, you can also run it with:

```bash
npx ./bin/releasebot.mjs
```

---

## First Run Setup

On first run, the CLI will prompt for:

- **GitHub token** (required, read-only permissions are enough)
- **OpenAI API key** (optional, only needed for AI summaries)

These are saved to `~/.releasebot-cli/config.json`.
Environment variables (`GITHUB_TOKEN`, `OPENAI_API_KEY`) override config if set.

---

## Creating a GitHub token (fine-grained, recommended)

Follow these steps in your browser:

1. Go to [https://github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)
   (this is the **fine-grained personal access token** page).

2. Press **Generate new token** → **Fine-grained token**.

3. Fill in:
   - **Token name**: e.g. `release-bot-cli`
   - **Expiration**: choose a sensible expiry (e.g. 90 days or “No expiration” if you rotate manually).

4. **Repository access**:
   - Choose **Only select repositories** → tick the repositories you’ll run this tool against.

5. **Permissions** (set to **Read-only** only):
   - **Pull requests** → **Read-only**
   - **Contents** → **Read-only** (optional but recommended to ensure commit message access)

6. Generate the token, copy it, and paste it into the prompt the first time you run `releasebot`.

That’s all — no write or admin permissions are required.

---

## Usage

```bash
# Basic run, will use stored history to avoid overlap
releasebot --build 1.32.0.1719

# Generate notes since explicit date
releasebot --since "2025-09-01"

# Generate notes since a git tag's date
releasebot --tag v1.31.0

# Skip AI narrative sections
releasebot --no-ai

# Don’t update stored history after this run
releasebot --no-history

# Ignore history, prompt for since again
releasebot --ignore-history
```
---

## Config & Tokens

Edit tokens/config manually:

```bash
releasebot config
```

Reset tokens from scratch:

```bash
releasebot reset-keys
```

Config is stored in:

```text
~/.releasebot-cli/config.json
```

---

## Example Output

```text
## Build version:

1.32.0.1719

## Full Changelog

- [**refactor(native): add margin bottom to plan title (](https://github.com/owner/repo/commit/abc123)[#2144](https://github.com/owner/repo/pull/2144)[)](https://github.com/owner/repo/commit/abc123)**

## Major features:
- Improvements to unlimited plan and home tabs

## Risks:
- None

## Impacts:
- None

...
```

Paste this Markdown directly into Notion or any doc.

---

## Roadmap

- [ ] Group PRs by author
- [ ] Conventional commit categorisation
- [ ] MDX/HTML output modes
- [ ] Per-repo default branch & versioning templates

---

## Licence

UNLICENCED
