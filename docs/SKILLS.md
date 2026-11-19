# Skills library page

Related: [#231](https://github.com/openTeamily/openTeamily/issues/231), [#10](https://github.com/openTeamily/openTeamily/issues/10), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This is the first `/skills` slice: a visible, searchable skills catalogue with
in-page install/uninstall toggles. It is **not** a skill runtime, marketplace,
credential surface or MCP implementation. The catalogue is OpenTeamily-authored;
it does not copy Teamily skill names, prose or counts.

## Page

`/skills` serves the shared app shell and shows:

- the `技能库` heading and a search field labelled `搜索技能`;
- ten skill cards, each with an icon slot, name, one-line description and an
  `安装` / `已安装` button;
- `共 N 个技能` or `显示 N / M 个技能` feedback;
- `没有匹配的技能` when the search has no hits.

Search filters by name and description in the loaded page. Installing highlights
the card and changes the button to `已安装`; clicking again removes it. The
installed set lives only in the page module, so a refresh resets every card. The
page never calls `fetch`, never writes storage and never creates or executes a
skill. The copy says this explicitly.

Every shell page that already has the app rail now links `技能` to `/skills`.

## Assets and routes

| Path | Content |
|---|---|
| `/skills` | HTML page (`Cache-Control: no-store`, strict CSP) |
| `/skills/app.mjs` | self-written `SKILLS` catalogue, `filterSkills`, `toggleSkill`, `mountSkills` |
| `/skills/app.css` | card grid, search pill, installed state, narrow layout |

Unknown `/skills/...` paths return `404`; queries, cross-origin requests and
non-GET methods are rejected like the other management pages. No API or database
schema is added.

## Explicitly not in this slice

- Real skill installation, execution, permissions, secrets or provider calls.
- Persistence across reloads, saved install state, or a user/workspace setting.
- MCP/provider OAuth, a marketplace, ratings, reviews, or a remote catalogue.
- Teamily skill names, prose, counts or visual comparison acceptance.

## Screenshot

`docs/screenshots/skills/` holds synthetic before/after-install captures. They are
review material, not browser E2E or Teamily comparison.

## Tests

`tests/test_skills_page.py` checks the served markup, strict headers, rejection
paths, the no-`fetch`/no-`innerHTML` script and the `技能` rail entry on every
shell page. `tests/skills_page.test.mjs` checks the catalogue bounds, search,
immutable toggle and the mounted page's filter/toggle/empty behaviour. These are
in-process/unit tests, not browser E2E or Teamily comparison.
