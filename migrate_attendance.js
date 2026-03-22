const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function migrate() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS student_attendance (
                id SERIAL PRIMARY KEY,
                "studentId" VARCHAR(50) NOT NULL,
                class VARCHAR(50),
                section VARCHAR(10),
                date DATE NOT NULL,
                status VARCHAR(20) NOT NULL, -- 'Present', 'Absent', 'Late', 'Half day', 'Holiday'
                remarks TEXT,
                submitted_by VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE("studentId", "date")
            )
        `);
        console.log('Attendance table created/already exists.');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();
