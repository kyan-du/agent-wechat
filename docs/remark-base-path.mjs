/**
 * Remark plugin that prefixes internal absolute links with Astro's base path.
 * Starlight auto-prefixes sidebar links but NOT links written in MDX content.
 */
export function remarkBasePath(base) {
  const prefix = base.replace(/\/$/, '');
  if (!prefix) return () => {};

  return () => (tree) => {
    visit(tree, 'link', (node) => {
      if (node.url && node.url.startsWith('/') && !node.url.startsWith(prefix)) {
        node.url = prefix + node.url;
      }
    });
  };
}

function visit(tree, type, fn) {
  if (tree.type === type) fn(tree);
  if (tree.children) {
    for (const child of tree.children) {
      visit(child, type, fn);
    }
  }
}
