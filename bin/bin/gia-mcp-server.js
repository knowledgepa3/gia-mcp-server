#!/usr/bin/env node

/**
 * GIA MCP Server — CLI Entry Point
 *
 * Governance Intelligence Architecture
 * Built on Anthropic's Model Context Protocol
 *
 * Copyright (c) 2025-2026 William J. Storey III / ACE Advising
 * All rights reserved. See LICENSE for details.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the compiled server
// Use pathToFileURL so Windows absolute paths (C:\...) become valid file:// URLs
// that Node.js ESM can import — raw Win32 paths trip ERR_UNSUPPORTED_ESM_URL_SCHEME.
await import(pathToFileURL(join(__dirname, '..', 'dist', 'index.js')).href);
