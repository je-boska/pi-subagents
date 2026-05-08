# pi-subagents

Parallel throwaway subagents for [pi](https://pi.dev).

This extension adds a `subagents` tool that starts isolated Pi sessions for research tasks and returns concise summaries to the main agent.

## Features

- Run one or more subagents in parallel
- Isolated throwaway sessions with `--no-session`
- Tiered model defaults: `very easy`, `easy`, `standard`, `hard`
- Tool modes: `none`, `read_only`, `read_bash`, `web`
- Guard extension blocks nested Pi spawning, writes, commits, and pushes
- Compact tool rendering

## Install

```bash
pi install git:git@github.com:je-boska/pi-subagents.git
```

Then restart pi or run:

```txt
/reload
```

## Usage

Ask Pi to delegate large/context-heavy research:

```txt
Use subagents to compare the auth implementation and routing patterns. Return concise findings with sources.
```

Or inspect defaults:

```txt
/subagents
```

Tier defaults:

- `very easy`: `gemma4:e4b-128k`
- `easy`: `openai-codex/gpt-5.4`
- `standard`: `openai-codex/gpt-5.4`
- `hard`: `openai-codex/gpt-5.5`

## Requirements

- Pi installed globally or available through the current Pi invocation
- Optional web mode requires `pi-brave-search-skill`
- Optional override for Brave skill path:

```bash
export PI_BRAVE_SEARCH_SKILL="$HOME/.pi/agent/git/github.com/je-boska/pi-brave-search-skill/skills/brave-search/SKILL.md"
```

## Local development

```bash
pi -e ./extensions/index.ts
```

Or symlink it into Pi's global extensions folder:

```bash
ln -sfn "$PWD/extensions" ~/.pi/agent/extensions/subagents
```

## Notes

- Subagents cannot spawn other subagents.
- Subagents cannot write files, commit, or push.
- Main session owns all mutations.
