/**
 * Scaffold a new React feature
 * Usage: pnpm generate:feature <name>
 * Example: pnpm generate:feature invoices
 */

import fs from 'fs';
import path from 'path';

const name = process.argv[2];
if (!name) {
  console.error('Usage: pnpm generate:feature <name>');
  process.exit(1);
}

const pascalCase = name.charAt(0).toUpperCase() + name.slice(1);
const kebabCase = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
const webSrc = path.resolve(__dirname, '../../apps/web/src');

// Feature page
const featureDir = path.join(webSrc, 'features', name);
fs.mkdirSync(featureDir, { recursive: true });

fs.writeFileSync(
  path.join(featureDir, `${kebabCase}-page.tsx`),
  `import { PageHeader } from '@/components/shared/page-header';

export function ${pascalCase}Page() {
  return (
    <div className="space-y-6">
      <PageHeader title="${pascalCase}" description="Manage ${name}" />
      <div className="rounded-lg border bg-card p-6">
        <p className="text-muted-foreground">TODO: Implement ${name} page</p>
      </div>
    </div>
  );
}
`,
);

// API file
fs.writeFileSync(
  path.join(webSrc, 'api', `${name}.api.ts`),
  `import { apiClient } from './client';

const BASE = '/${name}';

export const ${name}Api = {
  getAll: (params?: Record<string, unknown>) =>
    apiClient.get(BASE, { params }).then((r) => r.data),

  getById: (id: number) =>
    apiClient.get(\`\${BASE}/\${id}\`).then((r) => r.data),

  create: (data: Record<string, unknown>) =>
    apiClient.post(BASE, data).then((r) => r.data),

  update: (id: number, data: Record<string, unknown>) =>
    apiClient.patch(\`\${BASE}/\${id}\`, data).then((r) => r.data),

  delete: (id: number) =>
    apiClient.delete(\`\${BASE}/\${id}\`).then((r) => r.data),
};
`,
);

// Hook file
fs.writeFileSync(
  path.join(webSrc, 'hooks', `use-${name}.ts`),
  `import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ${name}Api } from '@/api/${name}.api';

export function use${pascalCase}s(params?: Record<string, unknown>) {
  return useQuery({
    queryKey: ['${name}', params],
    queryFn: () => ${name}Api.getAll(params),
  });
}

export function use${pascalCase}(id: number) {
  return useQuery({
    queryKey: ['${name}', id],
    queryFn: () => ${name}Api.getById(id),
    enabled: !!id,
  });
}

export function useCreate${pascalCase}() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ${name}Api.create,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['${name}'] }),
  });
}

export function useUpdate${pascalCase}() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      ${name}Api.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['${name}'] }),
  });
}

export function useDelete${pascalCase}() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ${name}Api.delete,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['${name}'] }),
  });
}
`,
);

console.log(`Feature "${name}" scaffolded:`);
console.log(`  - features/${name}/${kebabCase}-page.tsx`);
console.log(`  - api/${name}.api.ts`);
console.log(`  - hooks/use-${name}.ts`);
console.log(`\nDon't forget to add routes in app-router.tsx`);
