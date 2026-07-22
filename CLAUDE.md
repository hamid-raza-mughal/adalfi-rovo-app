# Design system

- `design-tokens/adalfi-design-tokens.json` is the design-system source artifact (the supplied Figma export). Never hand-edit it.
- `styles/tokens.generated.css`, `styles/recipes.generated.css`, and `styles/manifest.generated.json` are generated — never hand-edit them. Run `npm run tokens:generate` after the source JSON changes; `npm run tokens:check` fails CI if committed outputs are stale.
- Figma **variables** (`--figma-*` tokens) are the value and theme layer (colour, spacing, radius, typography scale, etc.), themed via `:root`/`[data-theme]`.
- Figma **styles** are the complete recipe layer (`text-style-*`, `paint-style-*`, `effect-style-*` in `styles/recipes.generated.css`). Prefer an approved recipe over manually recombining primitive variables it would otherwise duplicate.
- New and migrated UI must use Tailwind utilities, `styles/theme.css` semantic tokens (`--color-*`, `--radius-*`, `--font-sans`), and generated recipes — never hardcode a colour, typography, spacing, radius, dimension, border, effect, or layering value when an appropriate exported token already exists.
- Use `components/ui/MaterialSymbol.tsx` for every Material Symbols icon. Don't introduce a second icon system.
- `app/globals.css`'s legacy hand-written rules (below the `pre-Tailwind legacy rules` marker) are migration debt — don't extend them. Migrate and remove legacy CSS one component at a time as each is rebuilt with Tailwind/recipes, not in one bulk pass.

# Do not touch during UI work

Rovo requests, callbacks, SSE, polling, SQLite, Markdown rendering, API routing, and Quick Tunnel behaviour are unrelated to the design-system migration — preserve them exactly.
