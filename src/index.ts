#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  // Use the correct schema for the tool handler's return type
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod"; // Import zod directly
import fs from "fs/promises";
import path from "path";
import ignore from "ignore"; // For .gitignore parsing
import { isBinaryFile } from "isbinaryfile"; // For binary file detection

// Define the specific return type expected by the handler using z.infer
type ToolHandlerReturnType = z.infer<typeof CallToolResultSchema>;

/**
 * Create an MCP server with capabilities for tools.
 */
const server = new Server(
  {
    name: "codebase-context-dumper",
    version: "0.1.2", // Incremented version
    displayName: "Codebase Context Dumper",
    description: "An MCP server that provides a tool to recursively read and concatenate text files from a codebase directory, respecting .gitignore rules, skipping binary files, and supporting chunked output.",
  },
  {
    capabilities: {
      tools: {}, // Only tools capability needed
    },
  }
);

/**
 * Handler that lists available tools.
 * Exposes a single "get_codebase_context" tool.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "dump_codebase_context",
        description: "Recursively reads text files from a specified directory, respecting .gitignore rules and skipping binary files. Concatenates content with file path headers/footers. Supports chunking the output for large codebases.",
        inputSchema: {
          type: "object",
          properties: {
            base_path: {
              type: "string",
              description:
                "The absolute path to the project directory to scan.",
            },
            // max_total_size_bytes removed
            num_chunks: {
              type: "integer",
              description: "Optional total number of chunks to divide the output into (default: 1).",
              minimum: 1,
              default: 1,
            },
            chunk_index: {
              type: "integer",
              description: "Optional 1-based index of the chunk to return (default: 1). Requires num_chunks > 1.",
              minimum: 1,
              default: 1,
            },
          },
          required: ["base_path"],
        },
      },
    ],
  };
});

// Helper function to recursively find files, respecting nested .gitignore files
async function findFiles(
  currentDir: string, // Current directory being scanned
  parentIg: ignore.Ignore, // ignore object from parent (or initial)
  basePath: string // The original base path requested by the user
): Promise<string[]> {
  let results: string[] = [];
  let currentIg = parentIg; // Start with parent's ignore rules

  // Check for .gitignore in the current directory
  const gitignorePath = path.join(currentDir, ".gitignore");
  try {
    const content = await fs.readFile(gitignorePath, "utf-8");
    // Create a new ignore instance for this level, adding parent rules first, then current rules.
    currentIg = ignore().add(parentIg); // Add parent patterns
    currentIg.add(content); // Add current directory patterns
    // console.info(`Loaded .gitignore from ${gitignorePath}`); // Optional logging
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      // Log errors other than 'file not found'
      console.error(`Error reading .gitignore at ${gitignorePath}:`, error);
    }
    // If no .gitignore here or error reading, currentIg remains parentIg
  }

  const list = await fs.readdir(currentDir, { withFileTypes: true });

  for (const dirent of list) {
    const fullPath = path.join(currentDir, dirent.name);
    // Path relative to the *current* directory for ignore checking, as per Git behavior.
    const relativeToCurrentDir = dirent.name;

    // Check ignore rules using the *current* effective ignore instance
    if (currentIg.ignores(relativeToCurrentDir)) {
      // console.debug(`Ignoring ${relativeToCurrentDir} based on rules in/above ${currentDir}`); // Optional logging
      continue; // Skip ignored files/directories
    }

    if (dirent.isDirectory()) {
      // Pass the potentially updated currentIg down recursively
      results = results.concat(await findFiles(fullPath, currentIg, basePath));
    } else {
      // It's a file that's not ignored, add its full path
      results.push(fullPath);
    }
  }
  return results;
}


// Helper function to get the initial ignore instance for the base path
function getInitialIgnoreInstance(): ignore.Ignore {
  // Start with default ignores
  return ignore().add(".git");
}

// Helper to calculate size of a file with headers/footers
async function calculateFileSizeWithOverhead(filePath: string, basePath: string): Promise<{ size: number; content: string | null }> {
  try {
    const fileBuffer = await fs.readFile(filePath);
    if (await isBinaryFile(fileBuffer)) {
      return { size: 0, content: null }; // Skip binary files
    }
    const fileContent = fileBuffer.toString("utf-8");
    const relativePath = path.relative(basePath, filePath);
    const header = `--- START: ${relativePath} ---\n`;
    const footer = `\n--- END: ${relativePath} ---\n\n`;
    const contentToAdd = header + fileContent + footer;
    const size = Buffer.byteLength(contentToAdd, "utf-8");
    return { size, content: contentToAdd };
  } catch (e) {
    console.error(`Error reading file ${filePath} for size calculation:`, e);
    return { size: 0, content: null }; // Skip files that can't be read
  }
}


/**
 * Handler for the get_codebase_context tool.
 * Explicitly type the return value as a Promise of the expected type.
 */
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ToolHandlerReturnType> => {
  if (request.params.name !== "dump_codebase_context") {
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Unknown tool: ${request.params.name}`
    );
  }

  // Declare variables outside the try block
  let combinedContent = "";
  let filesProcessed = 0;
  let filesSkippedBinary = 0;
  // filesSkippedSize removed

  const args = request.params.arguments;

  // Validate arguments
  if (typeof args?.base_path !== "string" || args.base_path.trim() === "") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Missing or invalid required parameter: base_path (must be a non-empty string)"
    );
  }
  const basePath = path.resolve(args.base_path); // Ensure absolute path

  const numChunks = typeof args?.num_chunks === 'number' && args.num_chunks > 0 ? Math.floor(args.num_chunks) : 1;
  const chunkIndex = typeof args?.chunk_index === 'number' && args.chunk_index > 0 ? Math.floor(args.chunk_index) : 1;

  if (chunkIndex > numChunks) {
     throw new McpError(ErrorCode.InvalidParams, `chunk_index (${chunkIndex}) cannot be greater than num_chunks (${numChunks})`);
  }

  // maxSize removed

  try {
    // Check if base_path exists and is a directory
    const stats = await fs.stat(basePath);
    if (!stats.isDirectory()) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Provided base_path is not a directory: ${basePath}`
      );
    }

    const initialIg = getInitialIgnoreInstance();
    // Start the recursive search from the base path with the initial ignore instance
    const allFiles = await findFiles(basePath, initialIg, basePath);

    // --- Calculate total size and file details first ---
    let totalSize = 0;
    const fileDetails: Array<{ path: string; size: number; content: string | null }> = [];
    for (const filePath of allFiles) {
        const details = await calculateFileSizeWithOverhead(filePath, basePath);
        if (details.content !== null) { // Only include non-binary, readable files
            totalSize += details.size;
            fileDetails.push({ path: filePath, size: details.size, content: details.content });
            filesProcessed++; // Count files identified initially
        } else {
            filesSkippedBinary++; // Count binary/unreadable files skipped
        }
    }
    filesProcessed = 0; // Reset for actual content processing count

    // --- Determine chunk boundaries ---
    let targetChunkSize = totalSize;
    let startByte = 0;
    let endByte = totalSize;

    if (numChunks > 1) {
        targetChunkSize = Math.ceil(totalSize / numChunks); // Use ceil to ensure coverage
        startByte = (chunkIndex - 1) * targetChunkSize;
        endByte = chunkIndex * targetChunkSize;
        console.info(`Chunking: ${numChunks} chunks, returning chunk ${chunkIndex} (bytes ${startByte}-${Math.min(endByte, totalSize)} of ${totalSize})`);
    } else {
         console.info(`Not chunking. Total size: ${totalSize} bytes.`);
    }


    // --- Process files based on chunk ---
    let currentCumulativeSize = 0;
    let currentChunkSize = 0;

    for (const detail of fileDetails) {
        const fileStartByte = currentCumulativeSize;
        const fileEndByte = currentCumulativeSize + detail.size;

        let includeFile = false;
        if (numChunks > 1) {
            // Include if the file *starts* within the target chunk range
            if (fileStartByte >= startByte && fileStartByte < endByte) {
                 includeFile = true;
            }
        } else {
            // No chunking, include all non-binary/readable files
            includeFile = true;
        }

        if (includeFile && detail.content) {
            combinedContent += detail.content;
            currentChunkSize += detail.size;
            filesProcessed++;
        }

        currentCumulativeSize = fileEndByte; // Always advance cumulative size

        // If chunking, stop if we've passed the end byte for the current chunk
        // (This prevents adding files that start in the next chunk)
        if (numChunks > 1 && currentCumulativeSize >= endByte && chunkIndex < numChunks) {
             break;
        }
    }


    const summary = `Processed ${filesProcessed} files for chunk ${chunkIndex}/${numChunks}. Skipped ${filesSkippedBinary} binary/unreadable files initially. Total chunk size: ${currentChunkSize} bytes.`;
    console.info(summary); // Log summary to server console for debugging

    // Ensure the return value matches the ToolHandlerReturnType
    return {
      content: [
        {
          type: "text",
          text: combinedContent,
        },
      ],
    };
  } catch (error: any) {
    console.error("Error in get_codebase_context:", error);
    if (error instanceof McpError) {
      throw error; // Re-throw known MCP errors
    }
    // Throw generic internal error for unexpected issues
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to get codebase context: ${error.message}`
    );
  }
});

/**
 * Start the server using stdio transport.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Codebase Context Dumper MCP server running on stdio"); // Use console.error for logs
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
