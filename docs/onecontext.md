---
name: onecontext
description: Search for past conversations, discussions, events, and code changes in Aline history. Use this when user asks about existing objects (function, feature, variable), debug with some issues, find related information about certain objects that maybe existed in the past chat, or wants to explore project deeply. Uses a "Broad to Deep" exploration path (Event -> Session -> Turn -> Content).
---

# OneContext Skill

Invoke this skill with: `/onecontext`

This skill provides unified search across your project's Aline history, optimized for AI agents to navigate and explore context efficiently.

## Core Philosophy: Broad to Deep Exploration

Aline search is designed as a **navigation map**, not just a keyword matcher. Follow this hierarchical path to understand history:

1.  **Event** (`-t event`): High-level activity groupings (e.g., "Feature X development").
2.  **Session** (`-t session`): Specific tool-usage sessions (e.g., "Bug fix session for X").
3.  **Turn** (`-t turn`): Individual assistant/user exchanges (Summaries/Titles).
4.  **Content** (`-t content`): The "source of truth" - full raw dialogue JSONL.

## Usage Strategy

### 1. Default Mode: Regex (Grep-style)
`aline search` **defaults to regex mode** (`-E`). It replaces `grep` for all history searches.

```bash
# Broad pattern matching (Default Regex)
aline search "sqlite.*migration"

# Targeted type search (all = event + session + turn)
aline search "refactor" -t session
```

### 2. The "Content" Barrier
The default `all` type **does NOT search `content`** (raw dialogue) because it can be slow.
- Use `-t content` explicitly when you need to find code snippets or specific tool call details.

### 3. Navigation via IDs & Prefixes
Use the ID prefixes found in search results to narrow down your next command. All filter flags support **short ID prefixes**.

```bash
# Search only within a specific session (prefix supported)
aline search "error" -s abc123de

# Deep dive into raw content for a specific turn
aline search -t content "api_key" --turns t789
```

## When to Use This Skill

Invoke this skill when the user asks to:
- Find when a feature was discussed or implemented
- Research the history of a component or decision
- Research "why" a specific code change happened.
- Locate previous implementations or feature discussions.
- Perform pattern matching across history (replacing `grep`).

## Exploration Workflow for Agents

1.  **Step 1: Broad Search** (`aline search "<query>"`): Locate the general area of interest.
2.  **Step 2: Narrow Scope** (`aline search -s <prefix> -t turn`): Zoom into a specific session's turn summaries.
3.  **Step 3: Deep Dive** (`aline search -t content --turns <turn_id>` or `aline watcher session show <session_id>`): Read the actual dialogue and technical details.
4.  **Step 4: Event Context**: If an event is identified, use `aline watcher event show <event_id>` to see all related sessions.

## Command Reference

| Command | Use For |
|---------|---------|
| `aline search "pattern"` | **Regex search (default)** across events, turns, sessions |
| `aline search "query" --no-regex` | Exact keyword matching |
| `aline search -t content "pattern"`| **Deep search** in raw dialogue history |
| `aline search -s <id>` | Filter results to specific sessions |
| `aline search -e <id>` | Filter results to sessions within specific events |

## Important Notes

- **Case Sensitivity**: Default is **insensitive**.x
- **ID Prefixes**: You only need the first 8-12 characters of an ID (e.g., `abc12`) for filtering.
- **Next Steps**: The command output automatically suggests the best follow-up commands (e.g., `aline watcher session/event show`).
