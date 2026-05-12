import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCodeTools } from "./tools/code.js";
import { registerContextTools } from "./tools/context.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerMutationTools } from "./tools/mutations.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerRelationTools } from "./tools/relations.js";
import { registerSearchTools } from "./tools/search.js";
import { registerSessionTools } from "./tools/sessions.js";

const server = new McpServer({
  name: "memory",
  version: "1.0.0",
});

registerSessionTools(server);
registerProjectTools(server);
registerKnowledgeTools(server);
registerCodeTools(server);
registerContextTools(server);
registerGraphTools(server);
registerMutationTools(server);
registerRelationTools(server);
registerSearchTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
