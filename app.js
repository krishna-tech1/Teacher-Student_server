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
                `SELECT "studentId" as id, "firstName", "lastName", class, section, email, "dateOfBirth"::text as dob 
                 FROM students 
                 WHERE "studentId" = $1 AND "dateOfBirth"::text = $2`, 
                [id, dob]
            );
        } else if (role === 'teacher') {
            userResult = await pool.query(
                `SELECT "staffId" as id, "firstName", "lastName", email, dob::text as dob, class_teacher, "subjects_list" 
                 FROM staff 
                 WHERE LOWER("staffId") = LOWER($1) AND dob::text = $2`, 
                [id, dob]
            );
        } else {
            return res.status(400).json({ message: 'Invalid role specified' });
        }

        const user = userResult.rows[0];
        console.log(`[LOGIN DEBUG] Found user? ${user ? 'YES (' + user.id + ')' : 'NO (Check ID: ' + id + ', DOB: ' + dob + ')'}`);

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
                department: user.department,
                class_teacher: user.class_teacher,
                subjects: user.subjects_list ? JSON.parse(user.subjects_list) : []
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

// Leave Application Logic
portalRouter.post('/leaves', async (req, res) => {
    try {
        const { staffId, leaveType, startDate, endDate, reason } = req.body;
        
        // Validation
        if (!staffId || !leaveType || !startDate || !endDate || !reason) {
            return res.status(400).json({ message: 'All fields are mandatory.' });
        }

        // Check if startDate is in the past
        const start = new Date(startDate);
        const today = new Date();
        today.setHours(0,0,0,0);
        if (start < today) {
            return res.status(400).json({ message: 'You cannot apply for leave on past dates.' });
        }

        // Limit reason to 75 characters
        if (reason.length > 75) {
            return res.status(400).json({ message: 'Description cannot exceed 75 characters.' });
        }

        const query = `
            INSERT INTO staff_leaves ("staffId", "leaveType", "startDate", "endDate", "reason", "status")
            VALUES ($1, $2, $3, $4, $5, 'Pending')
            RETURNING *
        `;
        const result = await pool.query(query, [staffId, leaveType, startDate, endDate, reason]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Leave Application Error:', err);
        res.status(500).json({ message: 'Error submitting leave application.' });
    }
});

// Get Leave History for a Staff Member
portalRouter.get('/leaves/:staffId', async (req, res) => {
    try {
        const { staffId } = req.params;
        const result = await pool.query('SELECT * FROM staff_leaves WHERE "staffId" = $1 ORDER BY "appliedOn" DESC', [staffId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching leave history.' });
    }
});

// Get Timetable for a Staff Member
portalRouter.get('/timetable/:staffId', async (req, res) => {
    try {
        const { staffId } = req.params;
        const result = await pool.query('SELECT * FROM staff_timetables WHERE "staffId" = $1', [staffId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Timetable Error:', err);
        res.status(500).json({ message: 'Error fetching timetable.' });
    }
});

// Save/Update Timetable for a specific day
portalRouter.post('/timetable', async (req, res) => {
    try {
        const { staffId, day, periods } = req.body; 
        // periods: { period1: { subject, class }, period2: ... }
        
        const query = `
            INSERT INTO staff_timetables ("staffId", "day", "period1", "period2", "period3", "period4", "period5", "period6", "period7")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT ("staffId", "day") DO UPDATE SET
                "period1" = EXCLUDED."period1",
                "period2" = EXCLUDED."period2",
                "period3" = EXCLUDED."period3",
                "period4" = EXCLUDED."period4",
                "period5" = EXCLUDED."period5",
                "period6" = EXCLUDED."period6",
                "period7" = EXCLUDED."period7"
            RETURNING *
        `;
        const values = [
            staffId, 
            day, 
            periods.period1 || null, 
            periods.period2 || null, 
            periods.period3 || null, 
            periods.period4 || null, 
            periods.period5 || null, 
            periods.period6 || null, 
            periods.period7 || null
        ];
        const result = await pool.query(query, values);
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Save Timetable Error:', err);
        res.status(500).json({ message: 'Error saving timetable.' });
    }
});

// Get Students for a specific class and section
portalRouter.get('/students', async (req, res) => {
    try {
        const { className, section } = req.query;
        if (!className) {
            return res.status(400).json({ message: 'ClassName is required.' });
        }

        const query = `
            SELECT "studentId", "firstName", "lastName", class, section, email, "dateOfBirth"::text as dob, photo_url
            FROM students
            WHERE class = $1 ${section ? 'AND section = $2' : ''}
            ORDER BY "firstName" ASC
        `;
        const values = section ? [className, section] : [className];
        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Students Error:', err);
        res.status(500).json({ message: 'Error fetching students.' });
    }
});

// Get Marks for students in a class, section, subject
portalRouter.get('/marks', async (req, res) => {
    try {
        const { className, section, subject } = req.query;
        if (!className || !subject) {
            return res.status(400).json({ message: 'ClassName and Subject are required.' });
        }

        const query = `
            SELECT s."studentId", s."firstName", s."lastName", 
                   m1.marks as u1_marks, m1.remarks as u1_remarks,
                   m2.marks as u2_marks, m2.remarks as u2_remarks,
                   m3.marks as u3_marks, m3.remarks as u3_remarks
            FROM students s
            LEFT JOIN student_marks m1 ON s."studentId" = m1."studentId" AND m1.subject = $3 AND m1.exam_type = 'U1'
            LEFT JOIN student_marks m2 ON s."studentId" = m2."studentId" AND m2.subject = $3 AND m2.exam_type = 'U2'
            LEFT JOIN student_marks m3 ON s."studentId" = m3."studentId" AND m3.subject = $3 AND m3.exam_type = 'U3'
            WHERE s.class = $1 AND s.section = $2
            ORDER BY s."firstName" ASC
        `;
        const result = await pool.query(query, [className, section, subject]);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Marks Error:', err);
        res.status(500).json({ message: 'Error fetching marks.' });
    }
});

// Get Attendance for students in a class, section, date
portalRouter.get('/class-counts', async (req, res) => {
    try {
        const { classes } = req.query; // Expecting comma separated or multiple
        if (!classes) return res.json({});
        
        const classList = Array.isArray(classes) ? classes : classes.split(',');
        
        const counts = {};
        for (const cls of classList) {
            const parts = cls.trim().split(' ');
            let className = '';
            let section = '';
            if (parts.length > 1) {
                section = parts.pop();
                className = parts.join(' ');
            } else {
                className = parts[0];
            }

            const result = await pool.query(
                'SELECT COUNT(*) FROM students WHERE class = $1 AND section = $2',
                [className, section]
            );
            counts[cls] = parseInt(result.rows[0].count);
        }
        res.json(counts);
    } catch (err) {
        console.error('Count Error:', err);
        res.status(500).json({ message: 'Error fetching counts' });
    }
});

portalRouter.get('/attendance', async (req, res) => {
    try {
        const { className, section, date } = req.query;
        if (!className || !date) {
            return res.status(400).json({ message: 'ClassName and Date are required.' });
        }

        const query = `
            SELECT s."studentId", s."firstName", s."lastName", a.status, a.remarks
            FROM students s
            LEFT JOIN student_attendance a ON s."studentId" = a."studentId" AND a.date = $3
            WHERE s.class = $1 AND s.section = $2
            ORDER BY s."firstName" ASC
        `;
        const result = await pool.query(query, [className, section, date]);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Attendance Error:', err);
        res.status(500).json({ message: 'Error fetching attendance.' });
    }
});

// Save Attendance (Upsert)
// Fetch Relevant Announcements
portalRouter.get('/announcements', async (req, res) => {
    try {
        const { role, class: className, userId } = req.query;
        if (!role) return res.status(400).json({ message: 'Role is required' });

        // Build filtering conditions
        // Everyone sees 'all'
        // Teachers see 'teachers'
        // Students see 'students'
        // If className is provided, see 'class' matching className
        // Users also see announcements they SENT
        
        const conditions = ["target_type = 'all'"];
        
        if (role === 'teacher') {
            conditions.push("target_type = 'teachers'");
        } else if (role === 'student') {
            conditions.push("target_type = 'students'");
        }

        if (className) {
            conditions.push(`(target_type = 'class' AND target_class = '${className}')`);
        }

        if (userId) {
            conditions.push(`sender_id = '${userId}'`);
        }

        const query = `
            SELECT * FROM announcements 
            WHERE ${conditions.join(' OR ')}
            ORDER BY created_at DESC
        `;

        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Announcements Error:', err);
        res.status(500).json({ message: 'Error fetching announcements' });
    }
});

// Create Announcement
portalRouter.post('/announcements', async (req, res) => {
    try {
        const { sender_id, sender_name, sender_role, target_type, target_class, title, message, type } = req.body;
        
        if (!sender_id || !title || !message) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        // Rule 1: Character limits (25 for subject, 75 for message)
        if (title.length > 25) return res.status(400).json({ message: 'Subject exceeds 25 characters.' });
        if (message.length > 75) return res.status(400).json({ message: 'Message exceeds 75 characters.' });

        await pool.query(`
            INSERT INTO announcements (sender_id, sender_name, sender_role, target_type, target_class, title, message, type)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [sender_id, sender_name, sender_role, target_type, target_class, title, message, type || 'info']);

        res.json({ message: 'Announcement posted successfully' });
    } catch (err) {
        console.error('Post Announcement Error:', err);
        res.status(500).json({ message: 'Error posting announcement' });
    }
});

// Delete Announcement (Rule 2: Delete option only to who posted)
portalRouter.delete('/announcements/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId, role } = req.query; 

        const result = await pool.query('SELECT sender_id, sender_role FROM announcements WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Not found' });

        const ann = result.rows[0];

        // 1. Admin can delete any 'admin' announcement
        // 2. The original poster can delete their own
        const isAuthor = (ann.sender_id === userId);
        const isAdminOverAdmin = (role === 'admin' && ann.sender_role === 'admin');

        if (!isAuthor && !isAdminOverAdmin) {
            return res.status(403).json({ message: 'Only the sender can delete this' });
        }

        await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
        res.json({ message: 'Announcement deleted successfully' });
    } catch (err) {
        console.error('Delete Announcement Error:', err);
        res.status(500).json({ message: 'Error deleting announcement' });
    }
});

// Rule 3: Auto-delete after 5 days
const cleanupAnnouncements = async () => {
    try {
        console.log('[CLEANUP] Removing announcements older than 5 days...');
        await pool.query("DELETE FROM announcements WHERE created_at < NOW() - INTERVAL '5 days'");
    } catch (err) {
        console.error('Cleanup Error:', err);
    }
};

// Run cleanup every hour
setInterval(cleanupAnnouncements, 1000 * 60 * 60);
// Run once on startup
cleanupAnnouncements();

portalRouter.post('/attendance', async (req, res) => {
    let client;
    try {
        const { records } = req.body; 
        if (!records || !Array.isArray(records)) {
            return res.status(400).json({ message: 'Invalid attendance records.' });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        
        for (const record of records) {
            const { studentId, className, section, date, status, remarks, staffId } = record;
            const upsertQuery = `
                INSERT INTO student_attendance ("studentId", class, section, date, status, remarks, "submitted_by")
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT ("studentId", date)
                DO UPDATE SET status = EXCLUDED.status, remarks = EXCLUDED.remarks, created_at = CURRENT_TIMESTAMP
            `;
            await client.query(upsertQuery, [studentId, className, section, date, status, remarks, staffId]);
        }
        
        await client.query('COMMIT');
        res.json({ message: 'Attendance updated successfully.' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Save Attendance Error:', err);
        res.status(500).json({ message: 'Error saving attendance.' });
    } finally {
        if (client) client.release();
    }
});

// GET System Settings
portalRouter.get('/settings', async (req, res) => {
    try {
        const result = await pool.query('SELECT "key", value FROM system_settings');
        const settings = {};
        result.rows.forEach(r => settings[r.key] = r.value);
        res.json(settings);
    } catch (err) {
        console.error('Fetch Settings Error:', err);
        res.status(500).json({ message: 'Error fetching settings.' });
    }
});

// POST Update System Settings (Admin only action)
portalRouter.post('/settings', async (req, res) => {
    try {
        const { key, value } = req.body;
        if (!key) return res.status(400).json({ message: 'Setting key is required.' });

        await pool.query(`
            INSERT INTO system_settings ("key", value, updated_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
        `, [key, value]);

        res.json({ message: `Setting ${key} updated successfully.` });
    } catch (err) {
        console.error('Update Setting Error:', err);
        res.status(500).json({ message: 'Error updating setting.' });
    }
});

// Save Marks (Upsert)
portalRouter.post('/marks', async (req, res) => {
    let client;
    try {
        const { records } = req.body; 
        if (!records || !Array.isArray(records)) {
            return res.status(400).json({ message: 'Invalid marks records.' });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        
        for (const record of records) {
            const { studentId, className, section, subject, examType, marks, remarks } = record;
            const upsertQuery = `
                INSERT INTO student_marks ("studentId", class, section, subject, exam_type, marks, remarks)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT ("studentId", subject, exam_type)
                DO UPDATE SET marks = EXCLUDED.marks, remarks = EXCLUDED.remarks, created_at = CURRENT_TIMESTAMP
            `;
            await client.query(upsertQuery, [studentId, className, section, subject, examType, marks, remarks]);
        }
        
        await client.query('COMMIT');
        res.json({ message: 'Marks updated successfully.' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Save Marks Error:', err);
        res.status(500).json({ message: 'Error saving marks.' });
    } finally {
        if (client) client.release();
    }
});

// GET Student Attendance for a specific month (student self-view)
portalRouter.get('/student-attendance/:studentId', async (req, res) => {
    try {
        const { studentId } = req.params;
        const { month, year } = req.query;

        let query;
        let values;

        if (month && year) {
            query = `
                SELECT date::text, status, remarks
                FROM student_attendance
                WHERE "studentId" = $1
                  AND EXTRACT(MONTH FROM date) = $2
                  AND EXTRACT(YEAR FROM date) = $3
                ORDER BY date ASC
            `;
            values = [studentId, parseInt(month), parseInt(year)];
        } else {
            // Default: current month
            query = `
                SELECT date::text, status, remarks
                FROM student_attendance
                WHERE "studentId" = $1
                  AND EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM CURRENT_DATE)
                  AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)
                ORDER BY date ASC
            `;
            values = [studentId];
        }

        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error('Student Attendance Fetch Error:', err);
        res.status(500).json({ message: 'Error fetching student attendance.' });
    }
});

// GET Student Marks with Teacher Name (student self-view)
portalRouter.get('/student-marks/:studentId', async (req, res) => {
    try {
        const { studentId } = req.params;

        const query = `
            SELECT 
                m.subject,
                m.exam_type,
                m.marks,
                m.remarks,
                m.created_at,
                COALESCE(s."firstName" || ' ' || s."lastName", 'N/A') AS teacher_name
            FROM student_marks m
            LEFT JOIN staff s ON s."staffId" = m.submitted_by
            WHERE m."studentId" = $1
            ORDER BY m.subject ASC, m.exam_type ASC
        `;

        const result = await pool.query(query, [studentId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Student Marks Fetch Error:', err);
        res.status(500).json({ message: 'Error fetching student marks.' });
    }
});

app.use('/api/portal', portalRouter);

app.get('/', (req, res) => {
    res.send('XAN Portal Server is Online');
});

app.listen(port, () => {
    console.log(`Portal Server running on port: ${port}`);
});
