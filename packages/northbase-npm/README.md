# northbase

A local-first CLI for reading and writing text files stored in a Supabase `public.files` table. Uses email/password auth with RLS so each user only sees their own files. Session is stored locally — no env file required.

## Prerequisites

- Node.js >= 18
- A Supabase project with the following table and RLS enabled:

```sql
create table public.files (
  path        text primary key,
  content     text not null default '',
  owner_id    uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- RLS
alter table public.files enable row level security;

create policy "owner access" on public.files
  for all using (owner_id = auth.uid());

-- Auto-update updated_at on every write
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger files_updated_at
  before update on public.files
  for each row execute procedure public.set_updated_at();
```

## Install

```bash
npm install
npm link        # makes `northbase` available globally on your PATH
```

No environment file needed. The Supabase project URL and anon key are public constants baked into the CLI.

## Auth

### Log in

Prompts for your email and password interactively (password is not echoed):

```bash
northbase login
# Email: you@example.com
# Password:
# Logged in.
```

Your session (access + refresh tokens) is stored at `~/.northbase/session.json` with mode `600`. Tokens are refreshed automatically when they expire — you should only need to log in once.

### Log out

```bash
northbase logout
# Logged out.
```

Deletes `~/.northbase/session.json` and signs out server-side.

### Check who you are

```bash
northbase whoami
# Logged in as you@example.com (uuid...)
```

## Usage

### Get a file

Fetches file content and prints it to stdout. Uses a local cache at `~/.northbase/files/` and only downloads from Supabase when the remote `updated_at` timestamp differs from the cached value.

```bash
northbase get ideas.md
northbase get notes/todo.txt
```

### Put a file

Reads content from stdin, upserts it to Supabase, then updates the local cache.

```bash
printf "hello world\n" | northbase put test/cli.md
cat my-local-file.md   | northbase put ideas.md
echo "updated content" | northbase put notes/todo.txt
```

On success, prints a single confirmation line to stdout:

```
PUT ok test/cli.md bytes=12 updated_at=2024-01-15T10:30:00.000Z
```

### List remote files

Prints every file path stored remotely, one per line. Useful for discovery or scripting.

```bash
northbase list              # all files
northbase list memory/      # only paths starting with "memory/"
```

### Pull (bulk sync)

Downloads all remote files whose `updated_at` differs from the local cache. Useful for "discover and mirror all your notes so an agent can read them locally."

```bash
northbase pull              # sync everything
northbase pull memory/      # sync only files under memory/ prefix
```

Prints a summary line to stdout:

```
PULL ok files=12 downloaded=3 skipped=9
```

Per-file download progress goes to stderr. Pull never deletes local files.

## Local mirror

All files are mirrored at:

```
~/.northbase/files/<path>
```

Metadata (timestamps and byte counts) is stored at:

```
~/.northbase/index.json
```

Session tokens are stored at:

```
~/.northbase/session.json    (mode 600 — readable only by you)
```

The CLI compares `updated_at` timestamps before downloading — if your local copy is current, no content fetch is made.

## Limits

- Maximum file size: **500 KB** per file (enforced on both get and put)
- Paths must not contain `.`, `..`, empty segments, or leading slashes

## Debug output

Debug logs go to stderr so they never pollute stdout pipelines:

```
NORTHBASE GET local-hit ideas.md        # served from local cache
NORTHBASE GET remote-refresh ideas.md   # downloaded from Supabase
NORTHBASE PUT test/cli.md bytes=12 updated_at=2024-01-15T10:30:00.000Z
NORTHBASE session refreshing            # printed when access token is silently renewed
```
