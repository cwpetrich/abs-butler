import type { Meta } from '../api';

/**
 * What the organize path template understands, opened from beneath a template
 * field. Everything in it comes from the server — the placeholder descriptions
 * and the example paths, rendered by the same code organize moves files with —
 * so the help cannot drift from what a run actually does.
 */
export function TemplateHelp({ help }: { help: Meta['templateHelp'] | undefined }) {
  if (!help) return null;
  return (
    <details className="template-help">
      <summary>Template help</summary>

      <table>
        <thead>
          <tr>
            <th>Placeholder</th>
            <th>Becomes</th>
          </tr>
        </thead>
        <tbody>
          {help.fields.map((field) => (
            <tr key={field.name}>
              <td className="mono">{`{${field.name}}`}</td>
              <td>{field.description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Empty fields</h3>
      <p>
        A folder that renders empty is left out, and so is a separator left dangling at the start or
        end of a name. With <span className="mono">{'{author}/{series}/{sequence} - {title}'}</span>,
        a standalone book goes to <span className="mono">Author/Title</span> — not{' '}
        <span className="mono">Author// - Title</span>.
      </p>

      <h3>Sections</h3>
      <p>
        For a layout that changes shape rather than only losing a part, choose by whether a field has
        a value:
      </p>
      <ul>
        <li>
          <span className="mono">{'{if-series:…}'}</span> — included only when the book has a series.
        </li>
        <li>
          <span className="mono">{'{if-series:…|…}'}</span> — the part after{' '}
          <span className="mono">|</span> is used when it does not.
        </li>
      </ul>
      <p>
        Any placeholder can be the condition, and a section can hold folders, placeholders and other
        sections. A template is checked before it is saved or run: every branch needs{' '}
        <span className="mono">{'{title}'}</span>, and a misspelled placeholder is refused rather than
        quietly left out.
      </p>

      <h3>Examples</h3>
      {help.examples.map((example) => (
        <div key={example.template} className="template-example">
          <div className="mono">{example.template}</div>
          <table>
            <tbody>
              {example.renders.map((render) => (
                <tr key={render.book}>
                  <td className="dim">{render.book}</td>
                  <td className="mono">{render.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </details>
  );
}
