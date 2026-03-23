const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const check = async () => {
    try {
        console.log('Checking user_documents table...');
        const res = await pool.query("SELECT to_regclass('public.user_documents') as exists");
        console.log('Result:', res.rows[0].exists ? 'TABLE EXISTS' : 'TABLE MISSING');
        
        if (!res.rows[0].exists) {
            console.log('Creating table...');
            await pool.query(`
                CREATE TABLE IF NOT EXISTS user_documents (
                    id SERIAL PRIMARY KEY,
                    user_id VARCHAR(50) NOT NULL,
                    role VARCHAR(20) NOT NULL,
                    filename VARCHAR(255) NOT NULL,
                    file_url TEXT NOT NULL,
                    cloudinary_id VARCHAR(255) NOT NULL,
                    size BIGINT,
                    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('Table created.');
        } else {
            // Also check columns
            const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'user_documents'");
            console.log('Columns:', cols.rows.map(c => c.column_name).join(', '));
        }
        process.exit(0);
    } catch (err) {
        console.error('DATABASE ERROR:', err);
        process.exit(1);
    }
};

check();
