#!/usr/bin/env node
/**
 * Build & Validate Antigravity UI Localization Runtime Bundle
 * - Validates locales/manifest.json and every locale module JSON
 * - Compiles engine + all registered language packs into:
 *     1) dist/i18n-runtime.js    (self-contained IIFE for CDP launcher & ASAR preload)
 *     2) dist/menu-locales.json  (native Electron main-process menu dictionaries)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }
}

export function loadAndValidateLocales(rootDir = ROOT_DIR) {
  const localesDir = path.join(rootDir, 'locales');
  const manifestPath = path.join(localesDir, 'manifest.json');
  const manifest = readJson(manifestPath);

  if (!Array.isArray(manifest.locales) || manifest.locales.length === 0) {
    throw new Error('locales/manifest.json must contain a non-empty "locales" array');
  }

  const compiledLocales = [];
  const menuLocales = {};
  const seenCodes = new Set();

  for (const entry of manifest.locales) {
    if (!entry.code || typeof entry.code !== 'string') {
      throw new Error('Every locale entry in manifest.json must have a string "code"');
    }
    if (seenCodes.has(entry.code)) {
      throw new Error(`Duplicate locale code in manifest.json: ${entry.code}`);
    }
    seenCodes.add(entry.code);

    if (entry.builtin) {
      compiledLocales.push({
        code: entry.code,
        name: entry.name || entry.code,
        nativeName: entry.nativeName || entry.name || entry.code,
        direction: entry.direction || 'ltr',
        builtin: true,
        exact: {},
        patterns: [],
      });
      continue;
    }

    if (!entry.entry) {
      throw new Error(`Non-builtin locale "${entry.code}" must specify an "entry" file`);
    }

    const indexFile = path.join(localesDir, entry.entry);
    const localeDir = path.dirname(indexFile);
    const meta = readJson(indexFile);

    if (meta.code !== entry.code) {
      throw new Error(`Locale code mismatch: manifest="${entry.code}" vs ${indexFile}="${meta.code}"`);
    }

    const exact = {};
    const patterns = [];
    const menu = {};

    const modules = Array.isArray(meta.modules) ? meta.modules : [];
    for (const modName of modules) {
      const modPath = path.join(localeDir, modName);
      const modData = readJson(modPath);

      if (modData.exact && typeof modData.exact === 'object') {
        for (const [k, v] of Object.entries(modData.exact)) {
          if (typeof v !== 'string' || !v.trim()) {
            throw new Error(`Empty translation for key "${k}" in ${modPath}`);
          }
          exact[k] = v;
        }
      }

      if (Array.isArray(modData.patterns)) {
        for (const pat of modData.patterns) {
          if (!pat.regex || typeof pat.replace !== 'string') {
            throw new Error(`Invalid pattern entry in ${modPath}`);
          }
          // Validate RegExp syntax at build time
          new RegExp(pat.regex, pat.flags || '');
          patterns.push(pat);
        }
      }

      if (modData.menu && typeof modData.menu === 'object') {
        for (const [k, v] of Object.entries(modData.menu)) {
          if (typeof v !== 'string' || !v.trim()) {
            throw new Error(`Empty menu translation for key "${k}" in ${modPath}`);
          }
          menu[k] = v;
          // Antigravity 2.0 renders custom HTML titlebar menus on Windows/Linux,
          // so also expose menu labels to the renderer exact dictionary when not overridden.
          if (!Object.prototype.hasOwnProperty.call(exact, k)) {
            exact[k] = v;
          }
        }
      }
    }

    compiledLocales.push({
      code: meta.code,
      name: meta.name || entry.name || meta.code,
      nativeName: meta.nativeName || entry.nativeName || meta.code,
      direction: meta.direction || entry.direction || 'ltr',
      builtin: false,
      ui: meta.ui || {},
      exact,
      patterns,
    });

    menuLocales[meta.code] = menu;
  }

  const pkg = readJson(path.join(rootDir, 'package.json'));

  return {
    bundle: {
      version: pkg.version || '0.2.0',
      defaultLocale: manifest.defaultLocale || 'zh-CN',
      fallbackLocale: manifest.fallbackLocale || 'en',
      locales: compiledLocales,
    },
    menuLocales,
  };
}

function stripEsmSyntax(source) {
  return source
    .replace(/^export\s+(?=(function|const|let|var|class)\b)/gm, '')
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
}

export function buildBundle(rootDir = ROOT_DIR) {
  const { bundle, menuLocales } = loadAndValidateLocales(rootDir);

  const translatorSrc = stripEsmSyntax(
    fs.readFileSync(path.join(rootDir, 'engine', 'translator.js'), 'utf8'),
  );
  const uiSrc = stripEsmSyntax(
    fs.readFileSync(path.join(rootDir, 'engine', 'language-ui.js'), 'utf8'),
  );
  const entrySrc = stripEsmSyntax(
    fs.readFileSync(path.join(rootDir, 'engine', 'runtime-entry.js'), 'utf8'),
  );

  const runtimeJs = `/* Auto-generated by scripts/build-bundle.mjs — do not edit directly */
(function () {
  'use strict';
  const __BUNDLE__ = ${JSON.stringify(bundle)};
${translatorSrc}
${uiSrc}
${entrySrc}
  bootstrapAntigravityI18n(__BUNDLE__, createTranslator, mountLanguageUI);
})();
`;

  const distDir = path.join(rootDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  const runtimeOut = path.join(distDir, 'i18n-runtime.js');
  const menuOut = path.join(distDir, 'menu-locales.json');

  fs.writeFileSync(runtimeOut, runtimeJs, 'utf8');
  fs.writeFileSync(menuOut, JSON.stringify(menuLocales, null, 2) + '\n', 'utf8');

  return {
    runtimeOut,
    menuOut,
    localeCount: bundle.locales.length,
    totalExactKeys: bundle.locales.reduce((sum, l) => sum + Object.keys(l.exact || {}).length, 0),
  };
}

// CLI execution
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const validateOnly = process.argv.includes('--validate-only');
  try {
    if (validateOnly) {
      const { bundle } = loadAndValidateLocales(ROOT_DIR);
      console.log(
        `[OK] Validated ${bundle.locales.length} locales: ${bundle.locales.map((l) => l.code).join(', ')}`,
      );
    } else {
      const result = buildBundle(ROOT_DIR);
      console.log(
        `[OK] Built ${path.relative(ROOT_DIR, result.runtimeOut)} & ${path.relative(ROOT_DIR, result.menuOut)} (${result.localeCount} locales, ${result.totalExactKeys} UI entries)`,
      );
    }
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }
}
