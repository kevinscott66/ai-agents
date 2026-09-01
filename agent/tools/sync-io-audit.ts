#!/usr/bin/env bun
/**
 * T-303: Audit sync file I/O operations in hot paths
 * 
 * This script analyzes the codebase for synchronous file operations
 * that might be blocking the event loop in high-traffic scenarios.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface SyncIOUsage {
  file: string;
  line: number;
  operation: string;
  context: string;
  severity: 'low' | 'medium' | 'high';
}

function auditSyncIO(dir: string): SyncIOUsage[] {
  const findings: SyncIOUsage[] = [];
  
  function scanFile(filePath: string) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        
        // Look for sync file operations
        const syncOps = [
          'readFileSync',
          'writeFileSync', 
          'existsSync',
          'statSync',
          'appendFileSync',
          'unlinkSync',
          'mkdirSync'
        ];
        
        for (const op of syncOps) {
          if (trimmed.includes(op)) {
            // Determine severity based on context
            let severity: 'low' | 'medium' | 'high' = 'low';
            
            // High severity if in action dispatch, HTTP handlers, or message processing
            if (filePath.includes('action-dispatch.ts') || 
                filePath.includes('miniapp-server.ts') ||
                filePath.includes('orchestrator') ||
                trimmed.includes('handler') ||
                trimmed.includes('process')) {
              severity = 'high';
            }
            // Medium severity if in memory operations or frequent utilities  
            else if (filePath.includes('memory.ts') ||
                     filePath.includes('backup.ts') ||
                     filePath.includes('digest.ts')) {
              severity = 'medium';
            }
            
            findings.push({
              file: filePath.replace('/home/runner/work/ai-agents/ai-agents/agent/', ''),
              line: index + 1,
              operation: op,
              context: trimmed,
              severity
            });
          }
        }
      });
    } catch (error) {
      // Skip files we can't read
    }
  }
  
  function scanDirectory(dirPath: string) {
    try {
      const entries = readdirSync(dirPath);
      
      for (const entry of entries) {
        const fullPath = join(dirPath, entry);
        const stat = statSync(fullPath);
        
        if (stat.isDirectory()) {
          // Skip node_modules, .git, etc.
          if (!entry.startsWith('.') && entry !== 'node_modules' && entry !== 'data') {
            scanDirectory(fullPath);
          }
        } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
          scanFile(fullPath);
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }
  }
  
  scanDirectory(dir);
  return findings;
}

console.log("=== T-303 Sync I/O Audit Results ===\n");

const findings = auditSyncIO('/home/runner/work/ai-agents/ai-agents/agent');

// Group by severity
const highSev = findings.filter(f => f.severity === 'high');
const medSev = findings.filter(f => f.severity === 'medium');
const lowSev = findings.filter(f => f.severity === 'low');

console.log(`Found ${findings.length} sync I/O operations:`);
console.log(`- High severity (hot paths): ${highSev.length}`);
console.log(`- Medium severity (frequent): ${medSev.length}`);
console.log(`- Low severity (initialization): ${lowSev.length}\n`);

if (highSev.length > 0) {
  console.log("🔥 HIGH SEVERITY - Hot Path Sync I/O:");
  highSev.forEach(f => {
    console.log(`   ${f.file}:${f.line} - ${f.operation}`);
    console.log(`   ${f.context.substring(0, 80)}${f.context.length > 80 ? '...' : ''}`);
    console.log();
  });
}

if (medSev.length > 0) {
  console.log("⚠️  MEDIUM SEVERITY - Frequent Sync I/O:");
  medSev.forEach(f => {
    console.log(`   ${f.file}:${f.line} - ${f.operation}`);
    console.log(`   ${f.context.substring(0, 80)}${f.context.length > 80 ? '...' : ''}`);
    console.log();
  });
}

console.log("💡 RECOMMENDATIONS:");

if (highSev.length > 0) {
  console.log("- Replace high-severity sync operations with async equivalents");
  console.log("- Consider caching for frequently read files");
  console.log("- Use streaming for large file operations");
}

if (medSev.length > 0) {
  console.log("- Evaluate if medium-severity operations can be batched or cached");
  console.log("- Consider moving to worker threads for heavy file operations");
}

if (findings.length === 0) {
  console.log("✅ No sync I/O operations found in scanned files");
} else {
  console.log(`- Total sync operations to review: ${findings.length}`);
}

console.log("\n=== Analysis Complete ===");