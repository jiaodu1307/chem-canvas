// Plugin stdio entry: keep protocol stdout clean and share one local canvas.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp.js';
import { ensureCanvas } from './plugin-runtime.js';
try {
  const runtime = await ensureCanvas();
  const server = createMcpServer(runtime.url, {projectId:runtime.projectId});
  await server.connect(new StdioServerTransport());
} catch (error) { console.error(`Chem Canvas plugin: ${error.message}`); process.exitCode = 1; }
