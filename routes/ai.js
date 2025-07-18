// --- START FILE: Backend/routes/ai.js ---

const express = require('express');
const aiTools = require('../ai_tools');

// This is a simple "whitelist" of the tools the AI is allowed to call.
// This prevents any possibility of calling unintended functions.
const availableTools = {
  getTableState: aiTools.getTableState,
  getUserByUsername: aiTools.getUserByUsername,
};

const createAiRoutes = (pool) => {
  const router = express.Router();

  // IMPORTANT: Secure this endpoint!
  // Anyone who knows the URL could call your functions. We use a simple
  // secret key in the header. In a real production app, you might use
  // a more advanced system like Google Cloud IAM.
  const checkAiAuth = (req, res, next) => {
    const secret = req.headers['x-ai-secret-key'];
    if (!secret || secret !== process.env.AI_SECRET_KEY) {
      return res.status(403).json({ error: 'Forbidden: Invalid AI secret key.' });
    }
    next();
  };

  router.post('/execute-tool', checkAiAuth, async (req, res) => {
    // The AI Studio will send a body like: { "functionCall": { "name": "...", "args": {...} } }
    const { name, args } = req.body.functionCall;

    const tool = availableTools[name];

    if (!tool) {
      return res.status(404).json({ error: `Tool with name '${name}' not found.` });
    }

    try {
      // Call the requested function. We pass 'args' and the 'pool' for db access.
      const result = await tool(args, pool);

      // Send the result back to the AI Studio in the required format.
      res.json({
        functionResponse: {
          name,
          response: result,
        },
      });
    } catch (error) {
      console.error(`Error executing tool '${name}':`, error);
      res.status(500).json({ error: 'An internal server error occurred.' });
    }
  });

  return router;
};

module.exports = createAiRoutes;
// --- END FILE: Backend/routes/ai.js ---