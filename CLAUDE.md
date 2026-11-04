# abs-butler

## Website

ABS Butler's page on sidequestered.com, with its home-page card and support entry, lives in
`site/absbutler/` (`index.mdx`, `_card.json`, `_support.mdx`, `img/`). Pages are MDX using the
site's components; the rules, components and frozen URLs are in `docs/authoring.md` in `cwpetrich/sidequestered-site`. The `sidequestered` MCP server (set up in
that repo's README) serves that guide, validates this folder (`site_validate`), previews the
whole site with it (`site_preview`) and publishes it (`site_publish`).
The site is built and deployed only from `cwpetrich/sidequestered-site`.
`npm run site:publish` opens a PR there with this folder; it is for the maintainer, since that
repository is private. Never deploy the site from this repo. The rest is in that repo's README.
