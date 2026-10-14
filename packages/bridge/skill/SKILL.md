---
name: relay
description: >-
  Cross-device conversation relay. Use when this conversation needs to send a
  task to another registered conversation on another device, ask for its status,
  read a returned result, cancel a request, or recover its own identity after
  losing context. Tools are provided by the local relay MCP server (relay_*).
---

# Relay — cross-device conversation communication

## 1. What you are

You are a conversation registered in a relay roster. Your identity is decided by
the **local tool channel you were launched with** (each conversation gets its own
MCP instance with its `conv_id` injected). Never claim to be another conversation
in your message text — a self-declared identity is display-only and is not trusted.

## 2. Pair a second device (T1, bridge-managed)

The Bridge creates the local thread and registers its stable `conv_id`. After
`relay_whoami` confirms that identity, A explicitly calls `relay_pair_invite`.
Give the resulting secret code only to the intended B. It expires in ten minutes
and works once. Never create or refresh invitations automatically.

B puts the code in a private local file and starts the Bridge with its own
config and `--pair-code-file <file>`. B needs no root key or existing device
credential. Config `pairing` supplies `alias`, `role`, and `task`; `bindings`
starts empty. The Bridge creates a local T1 thread without a model turn, redeems
the code, and saves its new device credential and conversation binding before
opening the device channel. The project comes from A. Restart using the saved
config, with no pairing-code argument. Remove the consumed code file.

Config, code, and state belong outside Git and `~/.codex`. The saved config has
owner-only permissions (0600 on POSIX; restricted owner ACL on Windows). If an
exchange outcome is unknown, the Bridge pauses instead of redeeming again;
inspect the saved config and relay receipt before resetting local state.

## 3. Quick start — existing desktop conversation (T2)

You were registered by the Owner by hand and given one credential line
(`conv_id` + ticket). Show the credential to the tools to send work outbound.
**Call `relay_inbox` every time you are opened** — you have no automatic wake-up;
pending work is only visible when you ask.

## 4. Quick start — recovering after losing context

`relay_whoami` → `relay_discover` (filter by `project`/`role`) → `relay_inbox`
(who is waiting on me, who am I waiting on) → continue from the inbox. Never
guess a conversation from memory.

## 5. Tool card

| tool | what it does |
| --- | --- |
| `relay_whoami` | Who am I (conv_id + roster row). |
| `relay_discover` | List addressable conversations (discovery interface). |
| `relay_register` / `relay_join` | Legacy authenticated registration/join compatibility. |
| `relay_pair_invite` | Explicitly issue a ten-minute, single-use pairing code. |
| `relay_pair_revoke` | Revoke an unredeemed invitation by `invitation_id`. |
| `relay_pair_list` | List this runtime conversation's pairings. |
| `relay_pair_unpair` | End a pairing by `pairing_id`; manual permissions remain. |
| `relay_send` | Send a `TASK`/`QUERY`/`CLARIFY` (`to`, `type`, `body`, `context`, `result_requirement`, `ttl_s`). |
| `relay_status` | Read the three-layer status of a request. |
| `relay_read` | Read a result's full text + evidence references. |
| `relay_cancel` | Request cancellation. |
| `relay_inbox` | Inbox: what awaits me / guidance / results to verify / my outbox. |

## 6. Sending etiquette

- Target **must** be an exact `conv_id` — never guess from a similar alias.
- Body ≤ 64 KB. Give enough background.
- Large artifacts: use a Git reference or an already-authorized link, not the body.
- Default validity is 24 h; it only limits **when the task may still start**.
- Results must carry an accessible evidence reference; a bare local path is not
  evidence — mark inaccessible references explicitly.

## 7. Red lines

- No broadcast. No automatic re-dispatch (you may not rewrite `to`; forwarding is
  an explicit new request from the source, subject to the target's `allow_sources`).
- Do not auto-reply to a delivered result.
- Pairing tools always act for this runtime channel; never supply another
  conversation's identity to impersonate it. Bootstrap redemption runs in the
  local Bridge, never as an automatic tool call from delivered peer text.
- Respect the chain limit; if you hit it, wait for an explicit new root request.
- When waiting for the user / missing material, report a `STATUS` — never invent
  a result.

## 8. Diagnostics

CSV export and the overview endpoint belong to the Owner (root-key flow). Tools
never carry the root key.
