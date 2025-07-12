// In a new file at: /routes/admin.js

const express = require('express');
const fs = require('fs');
const path = require('path');

// This function creates the router and gives it the database pool
const createAdminRoutes = (pool) => {
  const router = express.Router();

  // A middleware to check if the user is an admin
  const isAdmin = async (req, res, next) => {
    // This assumes you have a way to get the user's ID from the request,
    // for example, from a decoded JWT token attached by another middleware.
    // Since your io.use middleware handles JWT, a separate one for Express is needed.
    // For now, we'll placeholder this logic.
    const userId = req.user?.id;
    if (!userId) return res.status(401).send('Authentication required.');

    try {
      const { rows } = await pool.query("SELECT is_admin FROM users WHERE id = $1", [userId]);
      if (rows.length > 0 && rows[0].is_admin) {
        return next();
      }
      res.status(403).send('Access Forbidden: Requires admin privileges.');
    } catch (err) {
      console.error("Admin check failed:", err);
      res.status(500).send('Server error during admin check.');
    }
  };

  router.post('/generate-schema', isAdmin, async (req, res) => {
    try {
      const sqlQuery = `
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' ORDER BY table_name, ordinal_position;
      `;
      const { rows } = await pool.query(sqlQuery);

      let markdownContent = '# Database Schema\n\n';
      let currentTable = '';
      rows.forEach(row => {
        if (row.table_name !== currentTable) {
          currentTable = row.table_name;
          markdownContent += `\n## \`${currentTable}\`\n`;
        }
        markdownContent += `- **${row.column_name}**: \`${row.data_type}\`\n`;
      });

      // Writes the file to the project's root directory
      const filePath = path.join(__dirname, '../../DATABASE_SCHEMA.md');
      fs.writeFileSync(filePath, markdownContent);

      res.status(200).send('DATABASE_SCHEMA.md updated successfully.');

    } catch (error) {
      console.error('Failed to generate schema file:', error);
      res.status(500).send('Internal Server Error');
    }
  });

  return router;
};

module.exports = createAdminRoutes;