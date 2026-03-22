const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function migrate() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                key VARCHAR(50) PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Initialize default academic start date if missing
        const today = new Date().toISOString().split('T')[0];
        await pool.query(`
            INSERT INTO system_settings (key, value) 
            VALUES ('academic_start_date', $1)
            ON CONFLICT (key) DO NOTHING
        `, [today]);

        console.log('System Settings table created/initialized.');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();
