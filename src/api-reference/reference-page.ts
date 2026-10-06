import type { OpenApiDocument, OpenApiOperation } from './openapi.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(value: string): string {
  return escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function operationHtml(method: string, path: string, operation: OpenApiOperation): string {
  const parameters = (operation.parameters ?? [])
    .map((p) => `<code>${escapeHtml(p.name)}</code> (${p.in}${p.required ? ', required' : ''})`)
    .join(', ');
  const body = operation.requestBody
    ? Object.keys(operation.requestBody.content).map(escapeHtml).join(' or ')
    : '';
  const responses = Object.entries(operation.responses)
    .map(([status, response]) => `<li><b>${status}</b> ${inline(response.description)}</li>`)
    .join('');
  return `<section id="${escapeHtml(operation.operationId)}">
<h3><span class="m ${method}">${method.toUpperCase()}</span> <code>${escapeHtml(path)}</code></h3>
<p>${inline(operation.summary)}</p>
${operation.description ? `<p class="d">${inline(operation.description)}</p>` : ''}
${parameters ? `<p>Parameters: ${parameters}</p>` : ''}
${body ? `<p>Body: ${body}</p>` : ''}
<ul>${responses}</ul>
</section>`;
}

export function renderReferencePage(document: OpenApiDocument): string {
  const byTag = new Map<string, string[]>();
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!operation) continue;
      const tag = operation.tags[0] ?? 'Other';
      byTag.set(tag, [...(byTag.get(tag) ?? []), operationHtml(method, path, operation)]);
    }
  }
  const tags = [...byTag.keys()].sort();
  const toc = tags
    .map((tag) => `<a href="#tag-${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`)
    .join(' · ');
  const sections = tags
    .map(
      (tag) =>
        `<h2 id="tag-${encodeURIComponent(tag)}">${escapeHtml(tag)}</h2>\n${(byTag.get(tag) ?? []).join('\n')}`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(document.info.title)} reference</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1d2330}
code{background:#f1f3f6;padding:0 .25rem;border-radius:3px}
section{border-top:1px solid #e3e6ea;padding:.5rem 0}
h3{margin:.25rem 0;font-size:1rem}.d{color:#4a5363}
.m{display:inline-block;min-width:4rem;font-size:.8rem;color:#fff;border-radius:3px;text-align:center;padding:.1rem .3rem}
.get{background:#2f6f9f}.post{background:#2f8f5b}.put{background:#8a6d1f}.patch{background:#7a5aa6}.delete{background:#a33c3c}
</style>
</head>
<body>
<h1>${escapeHtml(document.info.title)} (${escapeHtml(document.info.version)})</h1>
<p>${inline(document.info.description)}</p>
<p>Base path <code>${escapeHtml(document.servers[0]?.url ?? '')}</code>. Machine-readable: <a href="openapi.json">openapi.json</a> (OpenAPI ${document.openapi}).</p>
<nav>${toc}</nav>
${sections}
</body>
</html>
`;
}
