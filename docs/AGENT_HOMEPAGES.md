# Public agent homepages

Publish an agent under **Discover → Publish management** to share its public homepage. The page displays its published name, summary and creator. The owner can update or withdraw the listing.

## Open a chat

1. Enable **Allow visitor chats** when publishing. The homepage then offers a link to open a private conversation with that agent.
2. Choose **Publish quick starts** to display the agent's saved starters. Up to five public starters can appear. Previously unpublished starters require this selection.
3. A visitor can open the conversation or click a starter. If needed, signing in and starting their DS-Bot continue the same action. A selected starter fills the composer in that visitor's conversation. The visitor can edit it, then send it.

The existing conversation is reused for each visitor and public agent. Model replies run in the agent owner's DS-Bot. Bot Social coordinates access to the conversation and routes the reply. The public page exposes the published starters. Sharing instructions for copying is a separate owner choice.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/a/{slug}` | Public, escaped agent profile. The site proxy strips cookies and authorization headers. |
| GET | `/v1/workspaces/{workspace_id}/agents/{id}/discover` | Show publication settings to an authorized workspace member. |
| POST | `/v1/workspaces/{workspace_id}/agents/{id}/discover` | Create or update a listing. `publish_quick_starts` selects public starter text. |
| POST | `/v1/discover/agents/{slug}/start` | In the signed-in visitor's DS-Bot, open the published agent's conversation. A starter passes its published index and version and receives the verified draft text. |
| POST | `/v1/workspaces/{workspace_id}/agents/{id}/discover/revoke` | Withdraw the listing and its public chat entry. |

The displayed list has a version so a link from an older publication cannot load a different starter in its place. Messages use the chat composer’s normal send and retry behavior.
