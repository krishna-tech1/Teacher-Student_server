const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function migrate() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS announcements (
                id SERIAL PRIMARY KEY,
                sender_id VARCHAR(50) NOT NULL,
                sender_name VARCHAR(100) NOT NULL,
                sender_role VARCHAR(20) NOT NULL, -- 'admin', 'teacher'
                target_type VARCHAR(20) NOT NULL, -- 'all', 'students', 'teachers', 'class'
                target_class VARCHAR(50), -- Only used if target_type is 'class'
                title VARCHAR(200) NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('Announcements table created/verified.');
        process.exit(0);
    } catch (err) {
        console.error('Migration Error:', err);
        process.exit(1);
    }
}

migrate();
