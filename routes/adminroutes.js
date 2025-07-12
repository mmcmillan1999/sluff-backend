// In a new file like /routes/adminRoutes.js

const express = require('express');
const router = express.Router();
const db = require('../db'); // Your existing database connection
const fs = require('fs');
const path = require('path');

// A middleware to check if the user is an admin (IMPORTANT!)
const isAdmin = (req, res, next) => {
  // This is a placeholder for your actual authentication logic.
  // You would check the user's role from their session or JWT.
  if (req.user && req.user.isAdmin) {
    return next();
  }
  res.status(403).send('Access Forbidden');
};

// POST /api/admin/generate-schema
router.post('/generate-schema', isAdmin, async (req, res) => {
  try {
    // 1. Run the query to get schema data
    const sqlQuery = `
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position;
    `;
    const { rows } = await db.query(sqlQuery);

    // 2. Format the data into a Markdown string
    let markdownContent = '# Database Schema\n\n';
    let currentTable = '';
    rows.forEach(row => {
      if (row.table_name !== currentTable) {
        currentTable = row.table_name;
        markdownContent += `## \`${currentTable}\`\n`;
      }
      markdownContent += `- **${row.column_name}**: \`${row.data_type}\`\n`;
    });

    // 3. Write the content to the file
    // This places the file in the root of your project
    const filePath = path.join(__dirname, '../../DATABASE_SCHEMA.md');
    fs.writeFileSync(filePath, markdownContent);

    res.status(200).send('DATABASE_SCHEMA.md has been updated successfully.');

  } catch (error) {
    console.error('Failed to generate schema file:', error);
    res.status(500).send('Internal Server Error');
  }
});

module.exports = router;