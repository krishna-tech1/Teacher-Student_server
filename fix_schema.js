const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL
});

async function fix() {
    try {
        console.log('Fixing table: student_marks...');
        // Add submitted_by if not exists
        await pool.query('ALTER TABLE student_marks ADD COLUMN IF NOT EXISTS submitted_by TEXT');
        console.log('Column submitted_by added to student_marks.');
        
        // Also check student_attendance to be safe
        await pool.query('ALTER TABLE student_attendance ADD COLUMN IF NOT EXISTS submitted_by TEXT');
        console.log('Column submitted_by verified/added to student_attendance.');

        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

fix();
