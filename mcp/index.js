import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const PORT = process.env.MCP_PORT || 3001;

const app = express();
app.use(express.json());

// Active transports keyed by session id
const transports = new Map();

function createMcpServer() {
  const server = new McpServer({
    name: 'procure-ai-mcp',
    version: '0.1.0',
  });

  // find_supplier: look up a supplier by UNP (tax ID)
  server.tool(
    'find_supplier',
    'Find a supplier in Bitrix24 by UNP (tax identification number)',
    { unp: z.string().describe('Supplier UNP (tax ID)') },
    async ({ unp }) => {
      console.log(`[mcp] find_supplier called: unp=${unp}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ stub: true, message: 'stub: not implemented', unp }),
          },
        ],
      };
    }
  );

  // find_contract: look up a contract by supplier ID
  server.tool(
    'find_contract',
    'Find an active contract in Bitrix24 for the given supplier',
    { supplierId: z.string().describe('Bitrix24 supplier (company/contact) ID') },
    async ({ supplierId }) => {
      console.log(`[mcp] find_contract called: supplierId=${supplierId}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ stub: true, message: 'stub: not implemented', supplierId }),
          },
        ],
      };
    }
  );

  // find_product: look up a product/SKU in the catalog
  server.tool(
    'find_product',
    'Find a product in the Bitrix24 catalog by vendor code or name',
    {
      vendorCode: z.string().optional().describe('Vendor article / SKU'),
      name: z.string().optional().describe('Product name for fuzzy search'),
    },
    async ({ vendorCode, name }) => {
      console.log(`[mcp] find_product called: vendorCode=${vendorCode}, name=${name}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ stub: true, message: 'stub: not implemented', vendorCode, name }),
          },
        ],
      };
    }
  );

  // create_deal: create a purchase deal in Bitrix24
  server.tool(
    'create_deal',
    'Create a purchase deal in Bitrix24 with the extracted invoice data',
    {
      supplierId: z.string().describe('Bitrix24 supplier ID'),
      contractId: z.string().describe('Bitrix24 contract ID'),
      products: z.array(z.object({
        vendorCode: z.string().optional(),
        name: z.string(),
        price: z.number(),
        quantity: z.number(),
        currency: z.string(),
      })).describe('List of products to add to the deal'),
      sourceFile: z.string().describe('Original file name / path'),
      responsibleUserId: z.string().optional().describe('Bitrix24 user ID to assign the deal to'),
    },
    async ({ supplierId, contractId, products, sourceFile, responsibleUserId }) => {
      console.log(
        `[mcp] create_deal called: supplierId=${supplierId}, contractId=${contractId}, ` +
        `products=${products.length}, sourceFile=${sourceFile}, responsibleUserId=${responsibleUserId}`
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              stub: true,
              message: 'stub: not implemented',
              supplierId,
              contractId,
              sourceFile,
              responsibleUserId,
            }),
          },
        ],
      };
    }
  );

  return server;
}

// SSE endpoint — client connects here to receive events
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);

  res.on('close', () => {
    transports.delete(transport.sessionId);
  });

  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
  console.log(`[mcp] SSE client connected, sessionId=${transport.sessionId}`);
});

// POST endpoint — client sends messages here
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  if (!transport) {
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }

  await transport.handlePostMessage(req, res, req.body);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[mcp] procure-ai MCP server listening on port ${PORT}`);
});
