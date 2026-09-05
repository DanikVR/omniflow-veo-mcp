# Tool reference

All tools are exposed over MCP (stdio). The same operations are available on the local HTTP bridge — see the last section.

## `flow_status`

No arguments. Returns:

| Field | Meaning |
|---|---|
| `extension.connected` | the OmniFlow extension has pinged the bridge within the last 25 s |
| `extension.tabReady` | a Google Flow project tab is open and idle |
| `extension.license` | `trial`, `active`, `expired`, `unknown` — `expired` means tasks wait until a key is activated |
| `extension.director` | the director playbook sent by the extension; follow it |
| `extension.idle` | why the extension is not taking tasks: `throttled`, `panel` (a manual batch is running), `busy`, `license` |
| `queue.queued` / `queue.running` | items waiting / rendering |
| `now` | what the extension is doing right now (shown live in the panel) |
| `outDir` | where files are written |

## `flow_generate`

```json
{
  "items": [ { "prompt": "…", "frames": {"first": "C:/a.png", "last": "C:/b.png"}, "chain": false } ],
  "folder": "HotelPromo", "prefix": "scene",
  "model": "Omni 1.1 Flash", "aspect": "9:16", "length": 8, "resolution": "1080p", "chain": false
}
```

Returns `{ jobId, dir, items }` immediately. Job-level fields are defaults; every item may override them.

### Item fields

| Field | Type | Notes |
|---|---|---|
| `prompt` | string, **required** | English, one line. On-screen text stays in the user's language. |
| `frames` | `{first, last}` | Omni 1.1 keyframe transition: absolute paths to first- and last-frame images |
| `characters` | `[{name?, path}]` | reference photos or `.mp4`/`.mov` videos for consistency. Video: Flow uses the first 30 s only (3–10 s ideal). Not combinable with `frames`. |
| `mode` | `textToVideo` · `imageToVideo` · `components` · `textToImage` · `imageToImage` | picked automatically from the materials when omitted |
| `model` | string | label as shown in Flow, e.g. `Omni 1.1 Flash`, `Veo 3.1 Fast` |
| `aspect` | `16:9` · `9:16` · `1:1` | do **not** pass unless the user asked — with a video reference the bridge inherits the source orientation |
| `length` | 4 · 6 · 8 · 10 | seconds; 10 is the Omni maximum |
| `count` | 1–4 | variants per prompt |
| `resolution` | `360p` … `4k` | empty = Flow default |
| `useMention` | boolean | the character already exists in the Flow project: attach by `@name` instead of re-uploading |
| `chain` | boolean | this clip starts from the **last frame of the previous finished clip** of the job. Set on the 2nd and later items; not combinable with `characters` / `frames.first` |
| `flowAssets` | string[] | names of assets already in the Flow project library (file name without extension; a unique substring is enough) |

## `flow_wait`

| Field | Type | Notes |
|---|---|---|
| `jobId` | string, **required** | from `flow_generate` / `flow_edit` |
| `timeoutSec` | number | default 600, max 1800; a Flow clip takes 1–3 min |

Returns the job view with `finished`, `items[].status`, `items[].files` and `timedOut`.

## `flow_edit`

| Field | Type | Notes |
|---|---|---|
| `prompt` | string, **required** | what to change, in English — "change the sky to a storm, keep everything else the same" |
| `folder` | string | result subfolder, default `FlowEdit` |

Opens the last finished clip in the Omni 1.1 editor (video-to-video), applies the change, downloads the result. Requires **Trusted input** enabled in the extension settings. Wait with `flow_wait`.

## `flow_cancel`

No arguments. Removes queued items; clips already rendering finish normally.

## HTTP bridge

Base URL `http://127.0.0.1:8787` (override with `OF_HOST` / `OF_PORT`). Off-loopback requests need the `x-omniflow-token` header with the value of `~/.omniflow-token`.

| Route | Method | Purpose |
|---|---|---|
| `/ping` | GET | `{ok, service: "omniflow"}` |
| `/health` | GET | same payload as `flow_status` |
| `/jobs` | POST | body `{items, opts}` — same shape as `flow_generate` |
| `/jobs/:id` | GET | job view |
| `/cancel` | POST | drop queued items |
| `/hello`, `/brief`, `/next`, … | — | used by the extension; not for clients |

Environment: `OF_OUT` (output directory, default `./omniflow-out`), `OF_PORT`, `OF_HOST`, `OF_TOKEN` (overrides the token file).
