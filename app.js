const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5056;

// DB Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

app.use(cors());
app.use(express.json());

// Logger
app.use((req, res, next) => {
    console.log(`[PORTAL DEBUG] ${req.method} ${req.url}`);
    next();
});

// Portal Router
const portalRouter = express.Router();

// Login Logic
portalRouter.post('/login', async (req, res) => {
    try {
        const { id, dob, role } = req.body;
        console.log(`[LOGIN ATTEMPT] Role: ${role}, ID: ${id}`);

        let userResult;
        
        if (role === 'student') {
            userResult = await pool.query(
                `SELECT "studentId" as id, "firstName", "lastName", class, section, email, "dateOfBirth" 
                 FROM students 
                 WHERE "studentId" = $1 AND "dateOfBirth"::text = $2`, 
                [id, dob]
            );
        } else if (role === 'teacher') {
            userResult = await pool.query(
                `SELECT "staffId" as id, "firstName", "lastName", role as userRole, department, email, "dateOfBirth" 
                 FROM staff 
                 WHERE "staffId" = $1 AND "dateOfBirth"::text = $2`, 
                [id, dob]
            );
        } else {
            return res.status(400).json({ message: 'Invalid role specified' });
        }

        const user = userResult.rows[0];

        if (!user) {
            return res.status(401).json({ message: 'Invalid ID or Date of Birth' });
        }

        // Generate Token
        const token = jwt.sign(
            { id: user.id, role: role, name: `${user.firstName} ${user.lastName}` },
            process.env.JWT_SECRET || 'secret_portal',
            { expiresIn: '7d' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                name: `${user.firstName} ${user.lastName}`,
                email: user.email,
                role: role,
                class: user.class,
                section: user.section,
                department: user.department
            }
        });
    } catch (err) {
        console.error('Portal Login Error:', err);
        res.status(500).json({ message: 'Server error during portal login' });
    }
});

// Profile Logic
portalRouter.get('/profile', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'No token provided' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_portal');
        
        let result;
        if (decoded.role === 'student') {
            result = await pool.query('SELECT "studentId", "firstName", "lastName", class, section, email FROM students WHERE "studentId" = $1', [decoded.id]);
        } else {
            result = await pool.query('SELECT "staffId", "firstName", "lastName", department, email FROM staff WHERE "staffId" = $1', [decoded.id]);
        }

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'User profile not found' });
        }

        res.json({ user: result.rows[0] });
    } catch (err) {
        res.status(401).json({ message: 'Invalid or expired token' });
    }
});

app.use('/api/portal', portalRouter);

app.get('/', (req, res) => {
    res.send('XAN Portal Server is Online');
});

app.listen(port, () => {
    console.log(`Portal Server running on port: ${port}`);
});
