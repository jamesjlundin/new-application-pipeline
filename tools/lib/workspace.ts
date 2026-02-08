import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const KEY_CONFIG_FILES = [
  'package.json',
  'tsconfig.json',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Dockerfile',
  '.env.example',
  '.env.local.example',
  'README.md',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
  'vite.config.ts',
  'tailwind.config.ts',
  'tailwind.config.js',
  'drizzle.config.ts',
  'prisma/schema.prisma',
  'supabase/config.toml',
  'turbo.json',
  'pnpm-workspace.yaml',
  'app.json',
  'expo.config.js',
  'expo.config.ts',
];

export function getFileTree(workspacePath: string, depth: number = 4): string {
  try {
    const result = execSync(
      `find . -maxdepth ${depth} -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/dist/*' -not -path '*/.expo/*' | sort`,
      {
        cwd: workspacePath,
        encoding: 'utf-8',
        maxBuffer: 5 * 1024 * 1024,
      }
    );
    return result.trim();
  } catch {
    return '(failed to get file tree)';
  }
}

function readFileIfExists(filePath: string, maxLines: number = 100): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n... (truncated, ${lines.length} total lines)`;
    }
    return content;
  } catch {
    return null;
  }
}

export function getKeyConfigFiles(workspacePath: string): Record<string, string> {
  const configs: Record<string, string> = {};

  for (const relativePath of KEY_CONFIG_FILES) {
    const fullPath = path.join(workspacePath, relativePath);
    const content = readFileIfExists(fullPath);
    if (content !== null) {
      configs[relativePath] = content;
    }
  }

  // Also grab root-level package.json files in monorepo subdirs
  const commonSubdirs = ['apps', 'packages', 'services'];
  for (const subdir of commonSubdirs) {
    const subdirPath = path.join(workspacePath, subdir);
    if (fs.existsSync(subdirPath) && fs.statSync(subdirPath).isDirectory()) {
      try {
        const entries = fs.readdirSync(subdirPath);
        for (const entry of entries) {
          const pkgPath = path.join(subdirPath, entry, 'package.json');
          const content = readFileIfExists(pkgPath);
          if (content !== null) {
            configs[`${subdir}/${entry}/package.json`] = content;
          }
        }
      } catch {
        // skip
      }
    }
  }

  return configs;
}

export function summarizeRepoBaseline(workspacePath: string): string {
  const sections: string[] = [];

  sections.push('# Repo Baseline Summary\n');

  // File tree
  sections.push('## File Tree\n');
  sections.push('```');
  sections.push(getFileTree(workspacePath));
  sections.push('```\n');

  // Key config files
  const configs = getKeyConfigFiles(workspacePath);
  if (Object.keys(configs).length > 0) {
    sections.push('## Key Configuration Files\n');
    for (const [filePath, content] of Object.entries(configs)) {
      const ext = path.extname(filePath).slice(1) || 'text';
      sections.push(`### ${filePath}\n`);
      sections.push(`\`\`\`${ext}`);
      sections.push(content);
      sections.push('```\n');
    }
  }

  // Try to extract run commands from README
  const readmePath = path.join(workspacePath, 'README.md');
  const readme = readFileIfExists(readmePath, 200);
  if (readme) {
    sections.push('## README Excerpts\n');
    sections.push(readme);
    sections.push('');
  }

  return sections.join('\n');
}

