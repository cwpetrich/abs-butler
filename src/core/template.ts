/**
 * The organize path template's vocabulary, kept apart from organize itself so
 * the settings schema can validate a template without importing the code that
 * moves files — which imports the settings in turn.
 */

/**
 * Default layout, matching AudiobookShelf's own recommended structure:
 *   Author/Series/Vol - Title/
 * Series segments collapse away for standalone books.
 */
export const DEFAULT_TEMPLATE = '{author}/{series}/{sequence} - {title}';

export const TEMPLATE_FIELDS = ['author', 'title', 'series', 'sequence', 'year'] as const;

/**
 * What each placeholder produces, as the web UI's template help shows it.
 * Written here, beside the rendering it describes, so a change to one is made
 * next to the other.
 */
export const TEMPLATE_FIELD_HELP: Record<(typeof TEMPLATE_FIELDS)[number], string> = {
  author:
    'Every author, comma-separated, with credit roles such as "- adaptor" or "- foreword" removed.',
  title:
    "The book's title. Apostrophes are straightened, and characters a folder name cannot hold (/ \\ : * ? \" < > |) become -.",
  series: 'The first series the book belongs to, or empty for a standalone book.',
  sequence:
    'Its position in that series, padded to two digits so folders sort in order: 1 → 01, 1.5 → 01.5. A non-numeric position like "Prequel" is kept as it is.',
  year: 'The published year, or empty when it is not known.',
};

/** Templates shown in the help, each rendered against the sample books. */
export const TEMPLATE_EXAMPLES = [
  DEFAULT_TEMPLATE,
  '{author}/{title} ({year})',
  '{author}/{if-series:{series}/{sequence} - {title}|{title} ({year})}',
];

/**
 * A conditional section: `{if-series:...}`, or `{if-series:...|...}` with an
 * alternative for when the field is empty.
 *
 * Empty segments already collapse on their own, which covers the common case.
 * This is for a layout that differs in shape rather than only in what is
 * missing — a year on standalone books but not on series ones, say:
 *
 *   {author}/{if-series:{series}/{sequence} - {title}|{title} ({year})}
 *
 * Sections may contain `/`, placeholders and further sections. `|` is free to
 * mean "otherwise" because it can never appear in a rendered path: the
 * sanitizer replaces it in every value.
 */
type Node =
  | { kind: 'text'; text: string }
  | { kind: 'if'; field: string; then: Node[]; otherwise: Node[] };

class TemplateSyntaxError extends Error {}

function parse(template: string): Node[] {
  let index = 0;

  // Reads until the end of input, or — inside a section — until the `}` or
  // top-level `|` that ends the current branch.
  const branch = (nested: boolean): Node[] => {
    const nodes: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) nodes.push({ kind: 'text', text });
      text = '';
    };

    while (index < template.length) {
      const rest = template.slice(index);
      if (nested && (rest[0] === '}' || rest[0] === '|')) break;

      const section = /^\{if-(\w*):/.exec(rest);
      if (section) {
        flush();
        index += section[0].length;
        const then = branch(true);
        let otherwise: Node[] = [];
        if (template[index] === '|') {
          index += 1;
          otherwise = branch(true);
        }
        if (template[index] !== '}') {
          throw new TemplateSyntaxError(`{if-${section[1]}:…} is never closed with a matching }.`);
        }
        index += 1;
        nodes.push({ kind: 'if', field: section[1]!, then, otherwise });
        continue;
      }

      const placeholder = /^\{[^{}]*\}/.exec(rest);
      if (placeholder) {
        text += placeholder[0];
        index += placeholder[0].length;
        continue;
      }
      if (rest[0] === '{' || rest[0] === '}') {
        throw new TemplateSyntaxError(`Unbalanced ${rest[0]} in the path template.`);
      }
      if (rest[0] === '|') {
        throw new TemplateSyntaxError('| only means "otherwise" inside an {if-…:} section.');
      }
      text += rest[0];
      index += 1;
    }
    flush();
    return nodes;
  };

  return branch(false);
}

function flatten(nodes: Node[], has: (field: string) => boolean): string {
  return nodes
    .map((node) =>
      node.kind === 'text' ? node.text : flatten(has(node.field) ? node.then : node.otherwise, has),
    )
    .join('');
}

/** Every field an `{if-…:}` section asks about, anywhere in the tree. */
function conditionFields(nodes: Node[], into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.kind !== 'if') continue;
    into.add(node.field);
    conditionFields(node.then, into);
    conditionFields(node.otherwise, into);
  }
  return into;
}

/**
 * Resolves every `{if-…:}` section against what the book has, leaving a plain
 * template of placeholders and text. Throws on a malformed template, which
 * `templateProblem` has already reported for any template that got this far.
 */
export function resolveConditionals(template: string, has: (field: string) => boolean): string {
  return flatten(parse(template), has);
}

/**
 * What is wrong with a template, or null when nothing is.
 *
 * Rendering is forgiving on purpose — an unknown placeholder renders empty
 * rather than literally — which is exactly why a template is checked before it
 * is used: a typo like `{autor}` would otherwise quietly flatten every book in
 * the library into one folder, on every run and schedule that uses it.
 */
export function templateProblem(template: string): string | null {
  if (template.trim() === '') return 'The path template cannot be blank.';

  let nodes: Node[];
  try {
    nodes = parse(template);
  } catch (err) {
    if (err instanceof TemplateSyntaxError) return err.message;
    throw err;
  }

  const known = new Set<string>(TEMPLATE_FIELDS);
  const listed = TEMPLATE_FIELDS.map((k) => `{${k}}`).join(', ');
  const conditions = [...conditionFields(nodes)];
  const unknownCondition = conditions.filter((field) => !known.has(field));
  if (unknownCondition.length > 0) {
    return `Unknown condition ${unknownCondition.map((k) => `{if-${k}:…}`).join(', ')} — use one of ${listed}.`;
  }

  // Every combination of the fields the sections ask about, so a branch that
  // is only taken for some books is checked as carefully as the rest. Five
  // fields at most, so at most 32 layouts.
  for (let mask = 0; mask < 1 << conditions.length; mask++) {
    const layout = flatten(nodes, (field) => Boolean(mask & (1 << conditions.indexOf(field))));
    const unknown = [...layout.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      return `Unknown placeholder ${unknown.map((k) => `{${k}}`).join(', ')} — use ${listed}.`;
    }
    if (!layout.includes('{title}')) {
      const when = conditions.length > 0 ? ` (${describe(conditions, mask)})` : '';
      return `The path template needs {title} in every layout${when}, or books by one author would land in the same folder.`;
    }
    if (layout.startsWith('/') || layout.split('/').some((segment) => segment.trim() === '..')) {
      return 'The path template must stay inside the library folder.';
    }
  }
  return null;
}

function describe(conditions: string[], mask: number): string {
  return conditions
    .map((field, bit) => (mask & (1 << bit) ? `with ${field}` : `without ${field}`))
    .join(', ');
}
