# northbase-mcp

MCP server that exposes [northbase](../northbase-npm) file operations as tools for AI assistants.

## Prerequisites

- Node.js >= 18
- The `northbase` CLI installed and authenticated (`northbase login`)

The session at `~/.northbase/session.json` is shared between the CLI and this MCP server — no separate login needed.

## Install & run

```bash
npx northbase-mcp
```

Or install globally:

```bash
npm install -g northbase-mcp
northbase-mcp
```

## Claude Desktop configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "northbase": {
      "command": "npx",
      "args": ["northbase-mcp"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `northbase_get` | Get file content by path (uses local cache, fetches remote when stale) |
| `northbase_put` | Write content to a file (upsert) |
| `northbase_list` | List all file paths, with optional prefix filter |
| `northbase_pull` | Bulk-sync files to local cache, with optional prefix filter |
| `northbase_whoami` | Show the authenticated user's email and ID |
| `northbase_session_status` | Show session expiry and refresh status |

## Auth

This server reads `~/.northbase/session.json` — the same file written by `northbase login`. Tokens are refreshed automatically when they expire, identical to how the CLI handles auth.

If you see "Not logged in" errors, run `northbase login` in a terminal first.
