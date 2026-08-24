# @atbas/m-mcp-connector

The connector for **m-mcp**, a hosted MCP service that serves version-pinned
JazzCash and DGPays integration documentation to your coding agent.

Install it, put your token in your agent's settings, and your agent can ask
m-mcp for the guide, the exact wire field names, the meaning of a response code
or the go-live checklist — instead of answering from general knowledge of
payment gateways.

This package serves nothing itself. Every request it receives is forwarded to
the hosted endpoint under your access token, and the endpoint's answer is
returned unchanged.

## Install it globally

```bash
npm i -g @atbas/m-mcp-connector
```

Needs **Node 22 or newer**. Update it later with the same command.

Then add it to your agent's configuration. This is the block the m-mcp console
gives you when your token is issued:

```json
{
  "mcpServers": {
    "m-mcp": {
      "command": "m-mcp-connector",
      "env": {
        "M_MCP_TOKEN": "<the token the console showed you>"
      }
    }
  }
}
```

For Claude Desktop that file is `claude_desktop_config.json`; for other clients
it is whatever holds their `mcpServers` map.

Paste the block rather than typing the token on a command line. Every argument a
process is started with is readable by anything else on the machine, through `ps`
and `/proc/<pid>/cmdline`, and a token typed into a shell also stays in that
shell's history file. An MCP client's `env` block is neither.

## Configuration

| Setting      | How it is given                                               | Default                                         |
| ------------ | ------------------------------------------------------------- | ----------------------------------------------- |
| Access token | `M_MCP_TOKEN`                                                 | none — the connector will not start without one |
| Endpoint     | `M_MCP_URL`, or the first argument                            | `https://m-mcp.atbas.xyz/mcp`                   |
| Verbosity    | `M_MCP_LOG_LEVEL`: `silent`, `error`, `warn`, `info`, `debug` | `info`                                          |

There is deliberately no `--token=` flag, for the reason above. Configure the
credential through `M_MCP_TOKEN`; the console does not issue a credential-bearing
URL.

One older form is still accepted, and is documented here because the connector
really does honour it: a token supplied inside the endpoint URL as `?p=<token>`.
That is what merchants were given before this package existed. It is **stripped
from the URL before any request is made**, so the credential never reaches the
service's access log or your proxy's, and `M_MCP_TOKEN` wins when both are
present — with a warning on stderr saying so, if the two disagree. Nothing issues
that form any more; if you have one, move the value into `M_MCP_TOKEN` at your
convenience.

No `.env` file is ever read. Your client starts this process in whichever
directory it happens to be in — frequently one of your own projects — and a
dotenv loader would silently adopt whatever credentials that project holds.

## When it will not start

Run:

```bash
m-mcp-connector doctor
```

It prints the absolute path of the installed binary, your Node version, the
endpoint it would talk to, whether a token was found and where from — never its
value — the result of one live authenticated call when the configuration is
valid, and a configuration block built around that absolute path, ready to
paste. If the check fails, the report names whether the configuration,
credential, endpoint or connector needs attention.

| What you see                                 | What to do                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your client reports `ENOENT`, or "not found" | Your client cannot see `m-mcp-connector` on its `PATH`. Run `m-mcp-connector doctor` in a terminal and paste the configuration block it prints — it uses an absolute path. |
| `Node … is too old`                          | Upgrade Node to 22 or newer. `npm install` does not enforce this by default, which is why nothing warned you.                                                              |
| `No access token`                            | Set `M_MCP_TOKEN` in your client's `env` block.                                                                                                                            |
| `Malformed access token`                     | Copy the token again; a truncated paste is the usual cause.                                                                                                                |
| `did not accept this access token`           | Check it has not been revoked, and that it was copied in full.                                                                                                             |
| `refused this access token`                  | It has been revoked or has expired. Ask for a new one.                                                                                                                     |
| `could not be reached`                       | The endpoint is unreachable from this machine. Check any proxy.                                                                                                            |
| `A newer connector is available`             | Run `npm i -g @atbas/m-mcp-connector` again. The old one keeps working; this is advice, not a refusal.                                                                     |

**Why the first row happens.** A GUI-launched application on macOS inherits a
minimal `PATH` — roughly `/usr/bin:/bin:/usr/sbin:/sbin` — so a Node installed
through nvm or Homebrew is invisible to it, and the bare name `m-mcp-connector`
cannot be found. An absolute path in `command` fixes it, and `doctor` is how you
get that path without hunting for it.

## Diagnostics

**stdout carries the JSON-RPC protocol and nothing else.** A single stray byte
written there would desynchronise your client for the rest of the session, so
every diagnostic goes to stderr instead, one JSON object per line. Your client
captures that stream: in Claude Desktop it is under `Settings → Developer → Open
Logs Folder`.

`m-mcp-connector doctor` is the exception, and only because it runs _instead of_
a session — it never opens the protocol channel, so its report goes to stdout
where you can read, pipe or redirect it.

Every start-up failure carries a `fault` field saying whose move it is next:
`configuration` and `credential` are yours to fix, `endpoint` means the service
could not be reached and nothing you set is wrong, and `connector` means a defect
in this package worth reporting.

It exits `0` when your client closes the connection, which is what stopping the
server in your client does.

## What it does with your token

- It is sent to the endpoint in one place, an `Authorization: Bearer` header.
- If you supplied it inside the URL, the `?p=` parameter is removed before any
  request is made.
- It is never written to a log line, and never appears in a `doctor` report —
  the report is passed through the same redaction every log line gets, so a
  token that arrived inside somebody else's error message is scrubbed too.
  Diagnostics name the endpoint by origin and path only, never with a query
  string, and every line the connector writes is scrubbed of the token on the way
  out as a second line of defence.

Nothing else on your machine is read: the connector holds no credentials of your
own and reaches no local file.

## Where this comes from

[`eatbas/m-mcp-connector`](https://github.com/eatbas/m-mcp-connector) is the
generated public mirror of `packages/connector` in the private repository where
the m-mcp service is developed. Every release is built and published from that
mirror so npm can issue a provenance attestation. After installing, verify the
attestation with:

```bash
npm audit signatures
```

The manifest's `repository` deliberately carries no `directory` field: npm
validates the attestation against the repository the publishing workflow ran in,
and the package sits at that repository's root. This README keeps that rationale
beside the package metadata instead of maintaining a separate release document.

## Working on it

In the private m-mcp workspace:

```bash
pnpm --filter @atbas/m-mcp-connector build      # tsc, straight to dist/
pnpm --filter @atbas/m-mcp-connector typecheck
pnpm --filter @atbas/m-mcp-connector test
```

In a generated checkout of the public mirror:

```bash
npm ci
npm run build      # tsc, straight to dist/
npm run typecheck
npm test
```

The suite runs entirely in process: the hosted endpoint is stubbed by a real MCP
server behind the SDK's own Streamable HTTP transport, reached through an
injected `fetch`, so no test touches the network. `src/stdio.test.ts` is the one
to keep green above all others — it drives a whole request cycle, failure paths
included, and asserts that nothing but JSON-RPC framing reaches stdout and that
the token appears in no output at all.

The public mirror is **generated**. Fixes are made in the private workspace and
synced out; a change committed directly to the mirror is overwritten by the next
sync.

## Licence

MIT. See [LICENSE](./LICENSE).
