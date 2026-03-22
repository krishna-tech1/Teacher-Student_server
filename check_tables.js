const { Pool } = require('pg');
require('dotenv').config();

console.log('DB URL:', process.env.DATABASE_URL ? 'PRESENT' : 'MISSING');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function checkTables() {
    try {
        const res = await pool.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'");
        console.log('Tables Found:', res.rows.map(r => r.tablename).join(', '));
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

checkTables();
