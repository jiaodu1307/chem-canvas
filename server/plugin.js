// Plugin stdio entry: keep protocol stdout clean and share one local canvas.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import { createMcpServer } from './mcp.js';
import { ensureCanvas } from './plugin-runtime.js';
import { toolsForProfile } from './tool-profile.js';
try {
  const {values} = parseArgs({options:{url:{type:'string'}, project:{type:'string'}, profile:{type:'string'}}});
  const env = {...process.env};
  if (values.url !== undefined) env.CHEM_CANVAS_URL = values.url;
  if (values.project !== undefined) env.CHEM_CANVAS_PROJECT_ID = values.project;
  const toolProfile = values.profile ?? env.CHEM_CANVAS_TOOL_PROFILE;
  toolsForProfile(toolProfile);
  const runtime = await ensureCanvas({env});
  const server = createMcpServer(runtime.url, {projectId:runtime.projectId, toolProfile});
  await server.connect(new StdioServerTransport());
} catch (error) { console.error(`Chem Canvas plugin: ${error.message}`); process.exitCode = 1; }
