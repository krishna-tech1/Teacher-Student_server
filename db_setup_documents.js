const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const setup = async () => {
    try {
        console.log('Creating user_documents table...');
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
        console.log('Table created or already exists.');
        process.exit(0);
    } catch (err) {
        console.error('Error creating table:', err);
        process.exit(1);
    }
};

setup();
