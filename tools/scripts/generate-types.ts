/**
 * Generate TypeScript types from Prisma schema.
 *
 * In practice, the @amec/shared package is the source of truth for types
 * shared between frontend and backend. This script can be used to validate
 * that shared types stay in sync with the Prisma schema.
 *
 * Usage: pnpm ts-node tools/scripts/generate-types.ts
 */

import { execSync } from 'child_process';
import path from 'path';

const apiDir = path.resolve(__dirname, '../../apps/api');

console.log('Generating Prisma client...');
execSync('npx prisma generate', { cwd: apiDir, stdio: 'inherit' });
console.log('Prisma client generated successfully.');
console.log('');
console.log('Note: Shared types are maintained manually in packages/shared/src/types/');
console.log('Ensure they stay in sync with the Prisma schema.');
