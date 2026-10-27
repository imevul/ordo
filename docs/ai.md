# AI assistance

Ordo can use a language model for three things. All of them are optional and **off until an instance admin turns
them on**:

- **Summarize**: on an issue, _Ask AI → Summarize_ gives a short summary of the issue and its discussion: what it's
  about, where it stands, decisions, open questions and next steps.
- **Suggest properties**: _Ask AI → Suggest properties_ suggests a priority and labels, and lists open issues that
  look like the same thing. _Set_, _Add_ and _Mark duplicate_ apply a suggestion; nothing changes until you click.
- **Write with AI**: in the new-issue form, type rough notes into the title or description and click _Write with AI_.
  Ordo replaces them with a clear title and a structured description, and fills in priority and labels if you
  haven't. _Undo_ in the toast brings your notes back. Check the draft before you create it.

Every answer says which model wrote it. Models make mistakes; treat what they write as a draft.

AI assistance is separate from the [MCP server](mcp.md), which lets AI agents _you_ run (Claude, Claude Code,
Cursor…) work with Ordo under your account. That needs no setup by an instance admin.

## What is sent where

- When someone asks, the issue text **they can see** is sent to the model: the issue's title, description, status
  and other properties, its comments (the latest 60), sub-issue and related-issue titles, and the names of
  labels the team can use. For suggestions, Ordo also sends up to 15 open issues with similar words, again only
  ones that person can see. Issues in private teams they aren't in are never part of a request.
- Nothing is sent in the background: only when someone clicks.
- Ordo keeps no copy of prompts or answers. Summaries are kept in the browser until the page is reloaded.
- With the **Claude API**, that text goes to Anthropic under your API account's terms. With an
  **OpenAI-compatible** endpoint such as Ollama on your own hardware, it doesn't leave your network.
- Issue text is passed to the model as material, not instructions, and nothing a model answers is applied on its
  own. Still, someone who can write in an issue can try to steer what the model says about it.

## Setting it up (instance admins)

_Admin → Settings → AI assistance_: pick a provider, enter the model, and save. _Test connection_ sends a one-line
prompt and shows the answer and how long it took.

| Provider                                                | Model                                                                                     | Base URL                                                                    | API key                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| Claude API                                              | e.g. `claude-opus-5-5`; `claude-sonnet-5-5` and `claude-haiku-5-5` are faster and cheaper | Leave empty (`https://api.anthropic.com`), or a gateway in front of the API | Required, from the Claude Console           |
| OpenAI-compatible (Ollama, vLLM, LM Studio, llama.cpp…) | The server's model name, e.g. `llama3.3`, `qwen3`, `gpt-oss`                              | The URL ending in `/v1`, e.g. `http://localhost:11434/v1`                   | Optional; sent as `Authorization: Bearer …` |
- The API key is stored encrypted and only ever shown masked. Leave the field empty to keep it.
- Private and local addresses are allowed for the base URL, whatever _Allow private network targets_ says: only
  instance admins can set it, and a model on your LAN is the point.
- Ordo asks for JSON answers with a JSON schema (structured outputs). Endpoints that don't support `json_schema`
  get the request again without it; the prompt asks for the same JSON. Small local models get that wrong more
  often: if suggestions or drafts fail with "wasn't in the expected format", try a larger model.
- Reasoning models that put `<think>…</think>` into their answer work; Ordo removes it.

You can also set it in the environment, which pins it and locks the admin UI:

```bash
ORDO_AI_PROVIDER=anthropic          # anthropic, openai, or off
ORDO_AI_MODEL=claude-opus-5-5
ORDO_AI_API_KEY=sk-ant-…
# ORDO_AI_BASE_URL=http://host.docker.internal:11434/v1   # required for openai
```

### Ollama next to the Docker Compose setup

Inside the `ordo` container, `localhost` is the container itself. The Compose file maps `host.docker.internal` to
the host, so for Ollama running on the host use `http://host.docker.internal:11434/v1` and make Ollama listen on
more than loopback (`OLLAMA_HOST=0.0.0.0`). To run Ollama as a Compose service instead, add it to
`docker-compose.override.yml` and use `http://ollama:11434/v1`.

## Per workspace: the instance's model, your own, or off

Workspace admins choose under _Settings → AI assistance_:

- **The instance's model** (the default): whatever an instance admin set up, if anything.
- **Our own model**: a Claude API key or an OpenAI-compatible endpoint just for this workspace, used instead of the
  instance's for everyone in it, even when the instance has one. The key is stored encrypted, only admins see it
  (masked), and _Test_ sends a one-line prompt. _Remove our model_ deletes it and goes back to the instance's.
- **Off**: no AI buttons, and AI requests are refused for everyone in the workspace.

So a request uses: nothing if the workspace turned it off; else the workspace's own model if it chose that; else
the instance's. A workspace's own model is held to the instance's network rules, unlike the instance's: an
OpenAI-compatible URL on a private network (a model on your LAN) only works when an instance admin allows
_private network targets_, and a Claude model from a workspace always talks to `api.anthropic.com` (no custom base
URL). Changes are recorded in the audit log, never the key.

## API

The web app uses these endpoints; they work with an API key too. All are `POST`, read-only, limited to 20 requests a
minute per person, and answer `403 ai_unavailable` when AI is off for the instance or the workspace, and
`502 ai_failed` when the model fails or answers something unusable.

| Endpoint                               | Body               | Returns                                                                           |
| -------------------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `/api/w/<slug>/ai/issues/<id>/summary` | none               | `{ summary }` (Markdown)                                                          |
| `/api/w/<slug>/ai/issues/<id>/triage`  | none               | `{ priority, labelIds, duplicates: [{ id, identifier, title, reason }], reason }` |
| `/api/w/<slug>/ai/draft`               | `{ teamId, text }` | `{ title, description, priority, labelIds }`                                      |

Workspace admins manage the workspace's choice with `GET /api/w/<slug>/ai/settings`, `PUT /api/w/<slug>/ai/provider`
(`{ provider, model, baseUrl, apiKey }`; `apiKey: ""` keeps the stored one; also switches the workspace to it),
`DELETE /api/w/<slug>/ai/provider` and `POST /api/w/<slug>/ai/provider/test`. On and off, and which model, are
`settings.aiEnabled` and `settings.aiSource` (`instance` or `workspace`) in `PATCH /api/w/<slug>/`.

`<id>` is an issue id or identifier. `priority` in a triage answer is `null` when there's no change to suggest;
`labelIds` holds only labels the issue doesn't have yet.
